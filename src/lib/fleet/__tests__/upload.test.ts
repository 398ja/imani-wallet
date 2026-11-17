/**
 * @vitest-environment jsdom
 *
 * #591 criteria 6, 7, 8 and 12, and the identity rules of contract C1: deciding whether to upload
 * a held request, and running the #589 pipeline with the fleet key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip19, type Event } from 'nostr-tools'
import { base64 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { unzipSync, strFromU8 } from 'fflate'

import { decideUpload, runFleetUpload, type UploadEnv } from '../upload'
import { fleetSigner } from '../key'
import { readFleet, writeFleet, FLEET_CLIENT_MAX_PER_30D, type HeldRequest } from '../state'
import { unwrapSealed } from '../../giftWrap'
import { decryptSnapshot } from '../../snapshot/crypto'
import { verifyArchive } from '../../snapshot/verify'
import { displaySnapshotCode, normaliseSnapshotCode, snapshotCheckSymbol } from '../../snapshot/code'
import { SELF, seededSources, selfKey } from '../../snapshot/__tests__/fixtures'
import { absent } from './helpers'

// The seeded sources' own wallet, so the leak checks look for the key the data really belongs to.
const walletKey = selfKey
const WALLET = SELF
const WALLET_NPUB = nip19.npubEncode(WALLET)
const lender = { withPrivkey: <T,>(f: (k: Uint8Array) => T): T => f(walletKey.slice()) }
const NONCE = new Uint8Array(32).fill(3)
const signer = fleetSigner(lender, NONCE)
const supportKey = generateSecretKey()
const SUPPORT = getPublicKey(supportKey)
const CODE = displaySnapshotCode('7KQ4M2XD' + snapshotCheckSymbol('7KQ4M2XD'))
const CANON = (normaliseSnapshotCode(CODE) as { canonical: string }).canonical
const ROUND = 'F202511101000'
// Close to the seeded ledger (2025-11-09), so a 7-day window keeps it.
const NOW = Date.parse('2025-11-10T10:05:00Z')

function held(over: Partial<HeldRequest> = {}): HeldRequest {
  return { code: CODE, round: ROUND, expiresAt: NOW / 1000 + 3600, maxBytes: 5 * 1024 * 1024, historyDays: 7, ...over }
}

type Captured = { url: string; init: RequestInit }
function env(over: Partial<UploadEnv> = {}) {
  const calls: Captured[] = []
  const wraps: Event[] = []
  const blobs: Uint8Array[] = []
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const u = String(url)
    if (u.endsWith('/snapshot-codes/validate')) {
      return new Response(JSON.stringify({ ticket: ROUND, max_bytes: 999_999_999, expires_at: NOW / 1000 + 600, code_expires_at: NOW / 1000 + 3600, upload_grant: 'grant-f' }), { status: 200 })
    }
    if (u.endsWith('/upload')) {
      const bytes = new Uint8Array(init!.body as ArrayBuffer)
      blobs.push(bytes)
      return new Response(JSON.stringify({ sha256: bytesToHex(sha256(bytes)) }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as unknown as typeof globalThis.fetch
  const e: UploadEnv = {
    walletPubkey: WALLET,
    signer,
    support: { blossomUrl: 'http://localhost:28090', supportPubkey: SUPPORT, ttlSeconds: 7 * 86400 },
    storage: localStorage,
    fetch,
    publish: vi.fn(async (w: Event) => {
      wraps.push(w)
      return true
    }),
    collect: async () => seededSources({ memo: 'thanks Ottoline Brackenridge' }),
    connection: async () => ({ kind: 'wifi', saveData: false }),
    battery: async () => ({ charging: false, level: 0.9 }),
    visible: () => true,
    moneyBusy: () => false,
    now: () => NOW,
    ...over,
  }
  return { e, calls, wraps, blobs }
}

beforeEach(() => {
  localStorage.clear()
  writeFleet(WALLET, { optIn: { consent_version: 1, install_nonce: bytesToHex(NONCE), opted_in_at: NOW }, held: null, uploads: [], deregisterNonce: null })
})

describe('consent is required', () => {
  it('a held request without an opt-in record does nothing', async () => {
    localStorage.clear()
    const h = env()
    writeFleet(WALLET, { optIn: null, held: held(), uploads: [], deregisterNonce: null })
    expect(await runFleetUpload(h.e)).toBe('none')
    expect(h.calls.length).toBe(0)
  })
})

describe('criterion 6: upload only on Wi-Fi, with the battery OK, visible, and nothing in flight', () => {
  const ok = { connection: { kind: 'wifi' as const, saveData: false }, battery: { charging: false, level: 0.5 }, visible: true, moneyBusy: false, uploadsIn30d: 0 }
  it('all good: go', () => expect(decideUpload(ok)).toBe('go'))
  it('cellular, unknown, or Data Saver: hold', () => {
    expect(decideUpload({ ...ok, connection: { kind: 'cellular', saveData: false } })).toBe('hold')
    expect(decideUpload({ ...ok, connection: { kind: 'unknown', saveData: false } })).toBe('hold')
    expect(decideUpload({ ...ok, connection: { kind: 'wifi', saveData: true } })).toBe('hold')
  })
  it('battery below 0.2 and not charging: hold; charging or API absent: go', () => {
    expect(decideUpload({ ...ok, battery: { charging: false, level: 0.19 } })).toBe('hold')
    expect(decideUpload({ ...ok, battery: { charging: true, level: 0.05 } })).toBe('go')
    expect(decideUpload({ ...ok, battery: { charging: false, level: 0.2 } })).toBe('go')
    expect(decideUpload({ ...ok, battery: null })).toBe('go')
  })
  it('hidden, or a money screen open, or money in flight: hold', () => {
    expect(decideUpload({ ...ok, visible: false })).toBe('hold')
    expect(decideUpload({ ...ok, moneyBusy: true })).toBe('hold')
  })
  it('criterion 8: two uploads in 30 days: refuse', () => {
    expect(FLEET_CLIENT_MAX_PER_30D).toBe(2)
    expect(decideUpload({ ...ok, uploadsIn30d: 1 })).toBe('go')
    expect(decideUpload({ ...ok, uploadsIn30d: 2 })).toBe('refuse')
  })

  it('a held request is kept on cellular, and dropped at expires_at with "not sent"', async () => {
    let now = NOW
    const h = env({ connection: async () => ({ kind: 'cellular', saveData: false }), now: () => now })
    writeFleet(WALLET, { ...readFleet(WALLET), held: held() })
    expect(await runFleetUpload(h.e)).toBe('held')
    expect(readFleet(WALLET).held?.round).toBe(ROUND)
    expect(h.calls.length).toBe(0)
    now = NOW + 3600 * 1000
    expect(await runFleetUpload(h.e)).toBe('expired')
    expect(readFleet(WALLET).held).toBeNull()
    expect(readFleet(WALLET).uploads).toEqual([expect.objectContaining({ round: ROUND, state: 'not_sent' })])
    expect(h.calls.length).toBe(0)
  })

  it('battery low: held, no request', async () => {
    const h = env({ battery: async () => ({ charging: false, level: 0.1 }) })
    writeFleet(WALLET, { ...readFleet(WALLET), held: held() })
    expect(await runFleetUpload(h.e)).toBe('held')
    expect(h.calls.length).toBe(0)
  })
})

describe('criterion 8: the client caps uploads at 2 per 30 days, whatever the server asks', () => {
  it('a third request in 30 days is dropped without a single request', async () => {
    const h = env()
    const day = 86400 * 1000
    writeFleet(WALLET, { ...readFleet(WALLET), held: held(), uploads: [
      { round: 'F202511010000', at: NOW - 9 * day, state: 'deleted', counted: true },
      { round: 'F202510200000', at: NOW - 20 * day, state: 'received', counted: true },
    ] })
    expect(await runFleetUpload(h.e)).toBe('refused')
    expect(h.calls.length).toBe(0)
    expect(readFleet(WALLET).held).toBeNull()
  })
  it('an upload older than 30 days, or one never sent, does not count', async () => {
    const h = env()
    const day = 86400 * 1000
    writeFleet(WALLET, { ...readFleet(WALLET), held: held(), uploads: [
      { round: 'F202510010000', at: NOW - 31 * day, state: 'deleted', counted: true },
      { round: 'F202511010000', at: NOW - 2 * day, state: 'not_sent', counted: false },
      { round: 'F202511020000', at: NOW - 1 * day, state: 'sent', counted: true },
    ] })
    expect(await runFleetUpload(h.e)).toBe('sent')
  })
})

describe('the fleet pipeline (C1, C5, C6)', () => {
  it('validates, uploads, DMs and completes in #589 order, all by the fleet key, credentials omit', async () => {
    const h = env()
    writeFleet(WALLET, { ...readFleet(WALLET), held: held() })
    expect(await runFleetUpload(h.e)).toBe('sent')
    expect(h.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST /api/v1/support/snapshot-codes/validate',
      'PUT http://localhost:28090/upload',
      'POST /api/v1/support/snapshot-codes/complete',
    ])
    expect(h.wraps.length).toBe(1)
    for (const c of h.calls) expect(c.init.credentials).toBe('omit')
    for (const c of h.calls) {
      const auth = String((c.init.headers as Record<string, string>).Authorization)
      const ev = JSON.parse(new TextDecoder().decode(base64.decode(auth.slice(6))))
      expect(ev.pubkey).toBe(signer.pubkey)
    }
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual({ code: CANON })
    // The DM is sealed by the fleet key and names the round as the ticket.
    const opened = unwrapSealed(h.wraps[0], supportKey)!
    expect(opened.sealer).toBe(signer.pubkey)
    const dm = JSON.parse(opened.rumor.content)
    expect(dm.ticket).toBe(ROUND)
    // The archive: fleet manifest, no memos, empty correlation, signed by the fleet key.
    const plain = await decryptSnapshot(h.blobs[0], base64.decode(dm.key), base64.decode(dm.iv))
    const v = verifyArchive(plain)
    expect(v.ok).toBe(true)
    const m = (v as unknown as { manifest: Record<string, unknown> }).manifest
    expect(m).toMatchObject({ reason: 'fleet', round: ROUND, ticket_id: ROUND, wallet_pubkey: signer.pubkey })
    const files = unzipSync(plain)
    expect(Object.keys(files)).not.toContain('envelope/operator_only/memos.json')
    expect(JSON.parse(strFromU8(files['envelope/correlation.json']))).toEqual({ v: 1, entries: {} })
    // Recorded, held cleared, counted.
    const st = readFleet(WALLET)
    expect(st.held).toBeNull()
    expect(st.uploads[0]).toMatchObject({ round: ROUND, state: 'sent', counted: true })
  })

  it('the wallet pubkey and npub never appear in any request (url, header, body), the DM, or any archive byte', async () => {
    const h = env()
    writeFleet(WALLET, { ...readFleet(WALLET), held: held() })
    expect(await runFleetUpload(h.e)).toBe('sent')
    for (const c of h.calls) {
      const wire = [c.url, JSON.stringify(c.init.headers ?? {}), typeof c.init.body === 'string' ? c.init.body : ''].join('\n')
      expect(absent(wire, [WALLET, WALLET_NPUB]), c.url).toBeNull()
      // and the decoded NIP-98 / Blossom auth events inside the headers
      for (const v of Object.values((c.init.headers ?? {}) as Record<string, string>)) {
        if (v.startsWith('Nostr ')) expect(absent(new TextDecoder().decode(base64.decode(v.slice(6))), [WALLET, WALLET_NPUB])).toBeNull()
      }
    }
    const dm = unwrapSealed(h.wraps[0], supportKey)!
    expect(absent(JSON.stringify(h.wraps[0]) + JSON.stringify(dm), [WALLET, WALLET_NPUB])).toBeNull()
    const body = JSON.parse(dm.rumor.content)
    expect(absent(new TextDecoder().decode(base64.decode(body.delete_auth)), [WALLET, WALLET_NPUB])).toBeNull()
    const plain = await decryptSnapshot(h.blobs[0], base64.decode(body.key), base64.decode(body.iv))
    const text = Object.values(unzipSync(plain)).map((b) => strFromU8(b)).join('\n')
    expect(absent(text, [WALLET, WALLET_NPUB])).toBeNull()
    expect(absent(strFromU8(plain, true), [WALLET, WALLET_NPUB])).toBeNull()
    expect(absent(strFromU8(h.blobs[0], true), [WALLET, WALLET_NPUB])).toBeNull()
  })

  it('the grant size never exceeds min(request, 5 MB), whatever validate says', async () => {
    const h = env()
    writeFleet(WALLET, { ...readFleet(WALLET), held: held({ maxBytes: 50 }) })
    // A 50-byte cap cannot be met: the snapshot is not sent, silently, and recorded as such.
    expect(await runFleetUpload(h.e)).toBe('not_sent')
    expect(h.calls.map((c) => c.url)).toEqual(['/api/v1/support/snapshot-codes/validate'])
    expect(readFleet(WALLET).uploads[0]).toMatchObject({ state: 'not_sent', counted: false })
  })

  it('validate answering a different ticket than the round is refused before any upload', async () => {
    const h = env()
    ;(h.e.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => new Response(JSON.stringify({ ticket: 'T1042', max_bytes: 5e6, expires_at: NOW / 1000 + 600, upload_grant: 'g' }), { status: 200 }))
    writeFleet(WALLET, { ...readFleet(WALLET), held: held() })
    expect(await runFleetUpload(h.e)).toBe('not_sent')
    expect((h.e.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(h.blobs.length).toBe(0)
    expect(h.wraps.length).toBe(0)
  })

  it('a failed upload is silent and recorded "not sent"; a failure after the PUT still counts', async () => {
    const h = env()
    ;(h.e.publish as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    writeFleet(WALLET, { ...readFleet(WALLET), held: held() })
    await expect(runFleetUpload(h.e)).resolves.toBe('not_sent')
    expect(readFleet(WALLET).uploads[0]).toMatchObject({ round: ROUND, state: 'not_sent', counted: true })
    expect(readFleet(WALLET).held).toBeNull()
  })

  it('a held code never appears in a snapshot\'s data/ (nor the nonce)', async () => {
    const h = env()
    const fleetStorageCollect = async () => {
      const s = seededSources()
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!
        s.storage.push([k, localStorage.getItem(k)!])
      }
      return s
    }
    writeFleet(WALLET, { optIn: { consent_version: 1, install_nonce: bytesToHex(NONCE), opted_in_at: NOW }, held: held(), uploads: [], deregisterNonce: null })
    h.e.collect = fleetStorageCollect
    expect(await runFleetUpload(h.e)).toBe('sent')
    const dm = JSON.parse(unwrapSealed(h.wraps[0], supportKey)!.rumor.content)
    const plain = await decryptSnapshot(h.blobs[0], base64.decode(dm.key), base64.decode(dm.iv))
    const text = Object.values(unzipSync(plain)).map((b) => strFromU8(b)).join('\n')
    expect(absent(text, [CODE, CANON, bytesToHex(NONCE)])).toBeNull()
    expect(text).toContain('imani-wallet:fleet:<self>')
  })
})
