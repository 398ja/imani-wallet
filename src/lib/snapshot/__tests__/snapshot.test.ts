/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate'
import { base64 } from '@scure/base'
import { bech32 } from '@scure/base'
import { nip19, verifyEvent } from 'nostr-tools'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { buildSnapshot, SnapshotLeakError, finalScan, MAX_SNAPSHOT_BYTES } from '../build'
import { decryptSnapshot, encryptSnapshot } from '../crypto'
import { verifyArchive } from '../verify'
import {
  baseOptions, CANARY, FRIEND, FRIEND_NPUB, PII, SELF, SELF_NPUB, STALL, STALL_NPUB, TERMINAL,
  seededSources,
} from './fixtures'

const enc = new TextEncoder()

/** Every encoding a secret could hide in: verbatim, lowercase, hex of its bytes, base64, base64url. */
function forms(value: string): string[] {
  const bytes = enc.encode(value)
  const out = [value, value.toLowerCase(), bytesToHex(bytes), base64.encode(bytes), base64.encode(bytes).replace(/=+$/, '')]
  if (/^[0-9a-f]{64}$/.test(value)) {
    out.push(nip19.npubEncode(value), nip19.noteEncode(value))
  }
  if (value.startsWith('npub1') || value.startsWith('nsec1')) {
    const words = bech32.decode(value as `${string}1${string}`, 1000).words
    out.push(bytesToHex(bech32.fromWords(words)))
  }
  return out.filter((f) => f.length >= 8)
}

function archiveText(zip: Uint8Array): { all: string; data: string; files: Record<string, string> } {
  const files = Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, strFromU8(v)]))
  const all = Object.values(files).join('\n')
  const data = Object.entries(files).filter(([k]) => k.startsWith('data/')).map(([, v]) => v).join('\n')
  return { all, data, files }
}

describe('criterion 1: no secret survives', () => {
  it('none of the canary values, in any encoding, appears anywhere in the archive', async () => {
    const { zip } = await buildSnapshot(seededSources(), baseOptions())
    const { all } = archiveText(zip)
    for (const [name, value] of Object.entries(CANARY)) {
      for (const f of forms(value)) {
        expect(all.includes(f), `canary ${name} leaked as ${f.slice(0, 24)}`).toBe(false)
      }
    }
  })

  it('the archive also never carries the raw proof secret or C', async () => {
    const sources = seededSources()
    sources.vouchers[0] = { ...sources.vouchers[0], proofs: [{ secret: CANARY.proofSecret, C: CANARY.proofC, amount: 4 }] } as never
    const { zip } = await buildSnapshot(sources, baseOptions())
    const { all } = archiveText(zip)
    expect(all).not.toContain('canaryproofnonce0001')
    expect(all).not.toContain(CANARY.proofC)
  })
})

describe('criterion 21: AI-safe data layer', () => {
  it('no real identifier or PII reaches data/, each becomes a pseudonym or placeholder', async () => {
    const { zip } = await buildSnapshot(seededSources(), { ...baseOptions(), includeMemos: true })
    const { data, files } = archiveText(zip)
    const forbidden = [SELF, SELF_NPUB, STALL, STALL_NPUB, FRIEND, FRIEND_NPUB, TERMINAL, ...Object.values(PII), CANARY.email]
    for (const v of forbidden) {
      for (const f of forms(v)) expect(data.includes(f), `leaked ${v.slice(0, 20)} as ${f.slice(0, 20)}`).toBe(false)
    }
    expect(data).toMatch(/"self"/)
    expect(data).toMatch(/stall#1/)
    expect(data).toMatch(/send#1/)
    expect(data).toMatch(/terminal#1/)
    // Memo opted in: data/ has only its shape; the scrubbed text is in the operator-only envelope.
    const tx = JSON.parse(files['data/transactions.json'])
    const row = tx.rows.find((r: { send?: string }) => r.send)
    expect(row.memo_summary.has_email).toBe(true)
    const memo: string = JSON.parse(files['envelope/operator_only/memos.json']).memos[row.tx]
    expect(memo).toContain('<email>')
    expect(memo).toContain('<card>')
    expect(memo).toContain('<address>')
  })

  it('an opted-in memo with a name the wallet never stored stays out of data/ (operator-only envelope)', async () => {
    const sources = seededSources({ memo: 'thanks Ottoline Brackenridge' })
    const { zip } = await buildSnapshot(sources, { ...baseOptions(), includeMemos: true })
    const { data, files } = archiveText(zip)
    for (const f of forms('Ottoline')) expect(data.includes(f)).toBe(false)
    const tx = JSON.parse(files['data/transactions.json'])
    const row = tx.rows.find((r: { send?: string }) => r.send)
    expect(row.memo).toBeUndefined()
    expect(row.memo_summary).toEqual({ length: 28, words: 3, has_digits: false, has_url: false, has_email: false })
    const op = JSON.parse(files['envelope/operator_only/memos.json'])
    expect(op.memos[row.tx]).toBe('thanks Ottoline Brackenridge')
  })

  it('without the opt-in there is no memo anywhere, not even for the operator', async () => {
    const { zip } = await buildSnapshot(seededSources({ memo: 'thanks Ottoline Brackenridge' }), baseOptions())
    expect(archiveText(zip).all).not.toContain('Ottoline')
    expect(Object.keys(unzipSync(zip))).not.toContain('envelope/operator_only/memos.json')
  })

  it('no user-entered string reaches data/: terminal labels, request descriptions, shop names, or text in enum-shaped fields', async () => {
    const sources = seededSources()
    const name = 'Ottoline Brackenridge'
    sources.storage.push(
      ['imani-wallet:terminals:' + SELF, JSON.stringify([{ terminalPubkey: TERMINAL, name, label: name, role: name, state: name, enrolledAt: 1 }])],
      ['imani-wallet:payment-requests:' + SELF, JSON.stringify([{ id: 'r9', amount: 1, description: name, note: name, state: 'Ottoline', unit: name }])],
      ['imani-wallet:merchant:' + SELF, JSON.stringify({ name, shopName: name, currency: 'Ottoline', open: true })],
      ['imani-wallet:notifications:' + SELF, JSON.stringify([{ type: name, at: 2, body: name }])],
      ['imani:settings', JSON.stringify({ nickname: 'ottoline', greeting: name })],
    )
    sources.transactions[0] = { ...sources.transactions[0], type: name, face_unit: 'Ottoline' } as never
    sources.vouchers[0] = { ...sources.vouchers[0], status: name, backing_strategy: 'Ottoline' } as never
    const { zip } = await buildSnapshot(sources, { ...baseOptions(), includeMemos: true })
    const { data } = archiveText(zip)
    for (const f of forms('Ottoline')) expect(data.includes(f), f).toBe(false)
  })

  describe('a lowercase name typed into any string field never reaches data/ (closed sets)', () => {
    const N = 'brackenridge'
    type Mut = (s: ReturnType<typeof seededSources>) => void
    const cases: Array<[string, Mut]> = [
      ['voucher.backing_strategy', (s) => void ((s.vouchers[0] as Record<string, unknown>).backing_strategy = N)],
      ['voucher.source_transport', (s) => void ((s.vouchers[0] as Record<string, unknown>).source_transport = N)],
      ['voucher.status', (s) => void ((s.vouchers[0] as Record<string, unknown>).status = N)],
      ['voucher.face_unit', (s) => void ((s.vouchers[0] as Record<string, unknown>).face_unit = N)],
      ['tx.type', (s) => void ((s.transactions[0] as Record<string, unknown>).type = N)],
      ['tx.delivery_state', (s) => void ((s.transactions[0] as Record<string, unknown>).delivery_state = N)],
      ['tx.direction', (s) => void ((s.transactions[0] as Record<string, unknown>).direction = N)],
      ['tx.face_unit', (s) => void ((s.transactions[0] as Record<string, unknown>).face_unit = N)],
      ['bundle_part.redemptionStatus', (s) => void ((s.transactions[0] as Record<string, unknown>).bundle_parts = [{ voucherId: 'v1', amount: 1, timestamp: 1, redemptionStatus: N }])],
      ['error.name', (s) => void (s.errors[0].name = N)],
      ['error.code', (s) => void (s.errors[0].code = N)],
      ['error.frame', (s) => void (s.errors[0].frames = [N + '.ts:1'])],
      ['error.template', (s) => void (s.errors[0].template = 'thanks ' + N)],
      ['settings.theme', (s) => void s.storage.push(['imani:settings', JSON.stringify({ theme: N })])],
      ['pending send state', (s) => void s.storage.push(['imani-wallet:pending-sends:' + SELF, JSON.stringify([{ sendId: 's1', amount: 1, state: N, unit: 'eur' }])])],
      ['terminal role', (s) => void s.storage.push(['imani-wallet:terminals:' + SELF, JSON.stringify([{ terminalPubkey: TERMINAL, role: N, state: N, enrolledAt: 1 }])])],
      ['notification type', (s) => void s.storage.push(['imani-wallet:notifications:' + SELF, JSON.stringify([{ type: N, at: 1 }])])],
      ['backup kind', (s) => void s.storage.push(['imani-wallet:profile:' + SELF, JSON.stringify({ backups: [{ kind: N, at: 1 }] })])],
      ['environment build ref', (s) => void (s.environment.buildRef = N)],
      ['idb store name', (s) => void s.idbStores.push(N)],
      ['storage key suffix', (s) => void s.storage.push(['imani-wallet:notifications:' + N, '[]'])],
      ['storage key suffix on an excluded key', (s) => void s.storage.push(['imani-wallet:pending-sends:' + N, '[]'])],
    ]
    for (const [field, mut] of cases) {
      it(field, async () => {
        const s = seededSources()
        mut(s)
        const { zip } = await buildSnapshot(s, baseOptions())
        expect(archiveText(zip).data.toLowerCase()).not.toContain(N)
      })
    }
  })

  it('unknown keys are reported as a family and a size, never a suffix', async () => {
    const s = seededSources()
    s.storage.push(['imani-wallet:brand-new:brackenridge', 'x'], ['brackenridge-app:settings', 'y'])
    const { zip, manifest } = await buildSnapshot(s, baseOptions())
    expect(JSON.stringify(manifest.redaction.unknown_keys).toLowerCase()).not.toContain('brackenridge')
    expect(archiveText(zip).all.toLowerCase()).not.toContain('brackenridge')
    expect(manifest.redaction.unknown_keys).toContainEqual({ key: 'imani-wallet:<unknown>', bytes: 1 })
    expect(manifest.redaction.unknown_keys).toContainEqual({ key: '<unknown>', bytes: 1 })
  })

  it('finalScan accepts an inventory key only as prefix plus placeholder', () => {
    expect(() => finalScan({ 'data/x.json': '{"keys":{"imani-wallet:notifications:<self>":1}}' }, [])).not.toThrow()
    expect(() => finalScan({ 'data/x.json': '{"keys":{"imani-wallet:notifications:brackenridge":1}}' }, [])).toThrow(/unclassified/)
  })

  it('finalScan aborts on any string it cannot classify', () => {
    expect(() => finalScan({ 'data/x.json': '{"status":"brackenridge"}' }, [])).toThrow(/unclassified/)
    // An unknown key is as unclassified as an unknown value.
    expect(() => finalScan({ 'data/x.json': '{"brackenridge":1}' }, [])).toThrow(/unclassified/)
    expect(() => finalScan({ 'data/x.json': '{"send":"send#1","token":"h:0011223344556677","created_at":"2026-11-09T22:00:00Z","status":"active"}' }, [])).not.toThrow()
  })

  it('coarsens the fingerprint: user agent family, language only, rounded storage', async () => {
    const { zip } = await buildSnapshot(seededSources(), baseOptions())
    const env = JSON.parse(archiveText(zip).files['data/environment.json'])
    expect(env.browser).toBe('Chrome 131 / Android')
    expect(env.language).toBe('nl')
    expect(env.storage_usage_mb).toBe(12)
    expect(JSON.stringify(env)).not.toContain('Pixel')
  })

  it('a v2 keyset id (01 + 64 hex, NUT-02) goes in as its short id, and is never a reason to refuse', async () => {
    // Found in the post-merge e2e: the local mint's keyset is 01 + 64 hex. The 32+ hex pattern
    // refused every snapshot of a wallet holding a voucher from it. NUT-02's short id (the first
    // 8 bytes) names the keyset just as well and passes the scan unchanged.
    const v2 = '01ef5b830da1f32acd88bdf30c246627833672eb53112b7e2962a608ba96773aa9'
    const v1 = '009a1f293253e41e'
    const s = seededSources()
    s.proofShapes = { 'tid-own-1': { amounts: [512, 256], keysets: [v2, v1], hasDleq: true } }
    const { zip } = await buildSnapshot(s, baseOptions())
    const rows = JSON.parse(archiveText(zip).files['data/vouchers.json']).rows as { keyset_ids?: string[] }[]
    expect(rows.find((r) => r.keyset_ids)?.keyset_ids).toEqual(['01ef5b830da1f32a', v1])
  })

  it('a keyset-id field still refuses a hex string that is not a keyset id', async () => {
    // Only 01 + 64 lower-case hex is shortened. Any other long hex (a pubkey, a secret) stays and is refused.
    for (const bad of ['d5'.repeat(32), '02' + 'd5'.repeat(32), '01' + 'd5'.repeat(31), '01' + 'D5'.repeat(32)]) {
      const s = seededSources()
      s.proofShapes = { 'tid-own-1': { amounts: [1], keysets: [bad], hasDleq: false } }
      await expect(buildSnapshot(s, baseOptions()), bad.slice(0, 6)).rejects.toThrow(SnapshotLeakError)
    }
  })

  it('keeps the app version when it carries a build suffix, and still refuses anything else', async () => {
    // Found in the e2e: appVersion() is "0.41.0 (dev)", which read as "other" and lost the version.
    for (const [raw, want] of [['0.41.0 (dev)', '0.41.0 (dev)'], ['0.41.0-rc.2', '0.41.0-rc.2'], ['0.41.0', '0.41.0'], ['0.41.0 (Eric)', 'other'], ['x', 'other']]) {
      const s = seededSources()
      s.environment.appVersion = raw
      const { zip } = await buildSnapshot(s, baseOptions())
      expect(JSON.parse(archiveText(zip).files['data/environment.json']).app_version).toBe(want)
    }
  })

  it('an infrastructure URL whose host is or embeds an IP address is reduced, not a reason to refuse', async () => {
    // Found in the local e2e: the test stack's mint is http://127.0.0.1.mint:7777, and a self-hosted
    // gateway may be a LAN address. Neither may abort the snapshot or reach data/ as an address.
    const s = seededSources()
    s.environment.mintUrls = ['http://127.0.0.1.mint:7777', 'https://mint.imani.casa']
    s.environment.gatewayUrl = 'http://192.168.1.20:8081/api'
    s.environment.relayUrls = ['ws://[fd00::1]:7777']
    const { zip } = await buildSnapshot(s, baseOptions())
    const env = JSON.parse(archiveText(zip).files['data/environment.json'])
    expect(env.mint_urls).toEqual(['http://ip-host:7777', 'https://mint.imani.casa'])
    expect(env.gateway_url).toBe('http://ip-host:8081/api')
    expect(env.relay_urls).toEqual(['ws://ip-host:7777'])
    expect(archiveText(zip).data).not.toMatch(/192\.168|127\.0\.0\.1|fd00/)
  })
})

describe('criterion 11: public ids and K values', () => {
  it('no K value appears in data/, and support finds a known send_id via k_corr and the map', async () => {
    const opts = baseOptions()
    const { zip } = await buildSnapshot(seededSources(), opts)
    const { files, data } = archiveText(zip)
    const corr = JSON.parse(files['envelope/correlation.json']).entries as Record<string, string>
    for (const k of Object.values(corr)) expect(data).not.toContain(k)
    const { correlate } = await import('../ids')
    const k = correlate(opts.kCorr, PII.sendId)
    const pseudonym = Object.entries(corr).find(([, v]) => v === k)?.[0]
    expect(pseudonym).toMatch(/^send#\d+$/)
    // Without k_corr, a different key does not find it.
    expect(Object.values(corr)).not.toContain(correlate(new Uint8Array(32).fill(1), PII.sendId))
  })
})

describe('criteria 2 and 3: inventory', () => {
  it('unknown keys are reported by name and size only', async () => {
    const { zip, manifest } = await buildSnapshot(seededSources(), baseOptions())
    const unknown = manifest.redaction.unknown_keys
    // Reported by namespace family and byte length: a key's suffix may be typed text (review), so
    // "name" in criterion 3 is the family, e.g. imani-wallet:<unknown>.
    expect(unknown).toContainEqual({ key: '<unknown>', bytes: expect.any(Number) })
    expect(unknown.map((u) => u.key)).toContain('imani-wallet:<unknown>')
    expect(archiveText(zip).all).not.toContain('opaque value')
  })
})

describe('criterion 4: signature and tamper', () => {
  it('manifest hashes match, the signature verifies, any tampered byte fails', async () => {
    const { zip, manifest } = await buildSnapshot(seededSources(), baseOptions())
    const files = unzipSync(zip)
    for (const [path, h] of Object.entries(manifest.files)) {
      expect(bytesToHex(sha256(files[path]))).toBe(h)
    }
    const sig = JSON.parse(strFromU8(files['envelope/manifest.sig.json']))
    expect(verifyEvent(sig)).toBe(true)
    expect(sig.pubkey).toBe(SELF)
    expect(sig.content).toBe(bytesToHex(sha256(files['envelope/manifest.json'])))
    expect(verifyArchive(zip).ok).toBe(true)

    for (const path of Object.keys(files)) {
      const copy = { ...files }
      const b = new Uint8Array(copy[path])
      b[Math.floor(b.length / 2)] ^= 1
      copy[path] = b
      expect(verifyArchive(zipSync(copy)).ok, `tamper ${path}`).toBe(false)
    }
  })

  it('a signature by another key fails', async () => {
    const { zip } = await buildSnapshot(seededSources(), baseOptions())
    const files = unzipSync(zip)
    const sig = JSON.parse(strFromU8(files['envelope/manifest.sig.json']))
    sig.pubkey = STALL
    files['envelope/manifest.sig.json'] = strToU8(JSON.stringify(sig))
    expect(verifyArchive(zipSync(files)).ok).toBe(false)
  })
})

describe('criterion 5: AES-256-GCM', () => {
  it('round-trips, and the ciphertext contains no plaintext', async () => {
    const { zip } = await buildSnapshot(seededSources(), baseOptions())
    const sealed = await encryptSnapshot(zip)
    expect(sealed.key.length).toBe(32)
    expect(sealed.iv.length).toBe(12)
    expect(sealed.sha256).toBe(bytesToHex(sha256(sealed.ciphertext)))
    expect(strFromU8(sealed.ciphertext, true)).not.toContain('envelope/')
    expect(await decryptSnapshot(sealed.ciphertext, sealed.key, sealed.iv)).toEqual(zip)
    const bad = new Uint8Array(sealed.ciphertext)
    bad[0] ^= 1
    await expect(decryptSnapshot(bad, sealed.key, sealed.iv)).rejects.toThrow()
  })
})

describe('criterion 10: determinism', () => {
  it('same data, same key and salt, same time: identical data/ and manifest file hashes', async () => {
    const a = await buildSnapshot(seededSources(), baseOptions())
    const b = await buildSnapshot(seededSources(), baseOptions())
    const fa = archiveText(a.zip).files
    const fb = archiveText(b.zip).files
    for (const k of Object.keys(fa).filter((x) => x.startsWith('data/'))) expect(fa[k]).toBe(fb[k])
    expect(a.manifest.files).toEqual(b.manifest.files)
  })
})

describe('criterion 12: Stall vs Customer', () => {
  it('a Stall snapshot has Takings and Terminals, a Customer one has neither', async () => {
    const stall = archiveText((await buildSnapshot(seededSources({ stall: true }), baseOptions())).zip)
    const cust = archiveText((await buildSnapshot(seededSources({ stall: false }), baseOptions())).zip)
    const sd = JSON.parse(stall.files['data/derived.json'])
    const cd = JSON.parse(cust.files['data/derived.json'])
    expect(sd.stall.terminals.length).toBe(1)
    expect(sd.stall.takings).toBeDefined()
    expect(cd.stall).toBeUndefined()
    expect(cust.data).not.toContain('terminal#')
  })
})

describe('criterion 15: size budget', () => {
  it('a Stall whose snapshot would exceed the cap is trimmed by whole days of ledger only', async () => {
    const sources = seededSources()
    const day = 86400
    const base = 1762700000
    sources.transactions = Array.from({ length: 6000 }, (_, i) => ({
      id: 'bulk-' + i, type: 'payment', direction: 'in', timestamp: base - Math.floor(i / 200) * day, amount: i, face_unit: 'eur',
      counterparty: FRIEND,
    })) as never
    const cap = 120_000
    const { zip, manifest } = await buildSnapshot(sources, { ...baseOptions(), maxBytes: cap })
    expect(zip.length).toBeLessThanOrEqual(cap)
    expect(manifest.truncated).not.toBeNull()
    expect(manifest.truncated!.rows_omitted).toBeGreaterThan(0)
    expect(manifest.truncated!.since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const files = archiveText(zip).files
    const v = JSON.parse(files['data/vouchers.json'])
    expect(v.rows.length).toBe(2)
    const d = JSON.parse(files['data/derived.json'])
    expect(d.money_in_flight.pending_sends.count).toBe(1)
    // Kept rows are all on or after the since day, whole days.
    const tx = JSON.parse(files['data/transactions.json'])
    const since = Date.parse(manifest.truncated!.since + 'T00:00:00Z') / 1000
    expect(tx.rows.every((r: { timestamp: number }) => r.timestamp >= since)).toBe(true)
  }, 60_000)

  it('the default cap is 20 MB', () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(20 * 1024 * 1024)
  })
})

describe('criterion 22: fail closed', () => {
  it('a real identifier injected into data/ after build aborts with a reportable error', async () => {
    const sources = seededSources()
    let thrown: unknown
    try {
      await buildSnapshot(sources, {
        ...baseOptions(),
        afterData: (files) => {
          files['data/errors.json'] = files['data/errors.json'].replace('"rows"', `"x":"${STALL}","rows"`)
        },
      })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SnapshotLeakError)
    const err = thrown as SnapshotLeakError
    expect(err.file).toBe('data/errors.json')
    expect(err.kind).toBe('identifier')
    // The reportable error itself does not repeat the value it found.
    expect(err.message).not.toContain(STALL)
  })

  it('a PII pattern injected also aborts', () => {
    expect(() => finalScan({ 'data/x.json': '{"a":"mail me at x@y.example.com"}' }, [])).toThrow(SnapshotLeakError)
    expect(() => finalScan({ 'data/x.json': '{"a":"nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"}' }, [])).toThrow(SnapshotLeakError)
    expect(() => finalScan({ 'data/x.json': '{"a":"send#1"}' }, [])).not.toThrow()
  })
})
