/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateSecretKey, getPublicKey, nip19, verifyEvent, type Event } from 'nostr-tools'
import { base64 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { parseSupportSnapshot } from '../../config'
import { unwrapSealed, wrapMessage } from '../../giftWrap'
import { snapshotCheckSymbol, displaySnapshotCode } from '../code'
import { decryptSnapshot } from '../crypto'
import { SnapshotFlow, type FlowDeps } from '../flow'
import { applyAck, connectionAdvice, expireKept, readRecords } from '../service'
import { verifyArchive } from '../verify'
import { SELF, seededSources, selfKey, testSigner } from './fixtures'

const supportKey = generateSecretKey()
const SUPPORT = getPublicKey(supportKey)
const CODE = displaySnapshotCode('7KQ4M2XD' + snapshotCheckSymbol('7KQ4M2XD'))
const NOW = Date.parse('2026-11-09T22:04:40Z')

function harness(over: Partial<FlowDeps> = {}) {
  const calls: string[] = []
  const blobs = new Map<string, Uint8Array>()
  const wraps: Event[] = []
  const kept = new Map<string, Uint8Array>()
  const deps: FlowDeps = {
    config: { blossomUrl: 'http://localhost:28090', supportPubkey: SUPPORT, ttlSeconds: 7 * 86400 },
    signer: testSigner,
    collect: async () => seededSources(),
    now: () => NOW,
    post: vi.fn(async (path: string) => {
      calls.push('POST ' + path)
      if (path.endsWith('/validate')) {
        return new Response(JSON.stringify({ ticket: 'T1042', max_bytes: 20971520, expires_at: NOW / 1000 + 3600, code_expires_at: NOW / 1000 + 72 * 3600, upload_grant: 'grant-abc' }), { status: 200 })
      }
      return new Response('{"state":"used"}', { status: 200 })
    }),
    fetch: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`)
      const h = init!.headers as Record<string, string>
      if (h['X-Imani-Snapshot-Grant'] !== 'grant-abc') return new Response('', { status: 403 })
      const bytes = new Uint8Array(init!.body as ArrayBuffer)
      const sha = bytesToHex(sha256(bytes))
      blobs.set(sha, bytes)
      return new Response(JSON.stringify({ url: `http://localhost:28090/${sha}`, sha256: sha, size: bytes.length }), { status: 200 })
    }) as unknown as typeof fetch,
    sendDm: vi.fn(async (to: string, content: string) => {
      calls.push('DM ' + to)
      wraps.push(wrapMessage(selfKey, to, content))
      return true
    }),
    keep: async (sha, b) => void kept.set(sha, b),
    drop: async (sha) => void kept.delete(sha),
    ...over,
  }
  return { deps, calls, blobs, wraps, kept, flow: new SnapshotFlow(deps) }
}

beforeEach(() => localStorage.clear())

describe('the flow, end to end without a network', () => {
  it('criteria 5, 6: Blossom gets only ciphertext; the DM is a NIP-17 wrap to support with the schema', async () => {
    const { flow, blobs, wraps, calls } = harness()
    await flow.validate(CODE)
    const { size } = await flow.prepare(false)
    await flow.upload()
    expect(calls).toEqual(['POST /api/v1/support/snapshot-codes/validate', 'PUT http://localhost:28090/upload', 'DM ' + SUPPORT, 'POST /api/v1/support/snapshot-codes/complete'])
    const [sha, bytes] = [...blobs][0]
    expect(bytes.length).toBe(size)
    expect(new TextDecoder().decode(bytes)).not.toContain('envelope/')

    const opened = unwrapSealed(wraps[0], supportKey)
    expect(opened?.sealer).toBe(SELF)
    const dm = JSON.parse(opened!.rumor.content)
    expect(Object.keys(dm).sort()).toEqual(['code_ref', 'delete_auth', 'expires_at', 'file_name', 'iv', 'k_corr', 'key', 'sha256', 'size', 'ticket', 'type', 'url', 'v'].sort())
    expect(dm).toMatchObject({ type: 'imani-support-snapshot', v: 1, ticket: 'T1042', sha256: sha, size, url: `http://localhost:28090/${sha}` })
    expect(dm.file_name).toMatch(/^imani-snapshot_T1042_[0-9a-f]{8}_20261109T220440Z_v1\.imsnap$/)
    // Support can decrypt and verify with what the DM carries.
    const zip = await decryptSnapshot(bytes, base64.decode(dm.key), base64.decode(dm.iv))
    expect(verifyArchive(zip).ok).toBe(true)
    // delete_auth is a valid kind 24242 t=delete for this blob, signed by the wallet.
    const del = JSON.parse(new TextDecoder().decode(base64.decode(dm.delete_auth)))
    expect(verifyEvent(del)).toBe(true)
    expect(del.kind).toBe(24242)
    expect(del.tags).toContainEqual(['t', 'delete'])
    expect(del.tags).toContainEqual(['x', sha])
    expect(readRecords(SELF)[0].state).toBe('shared')
  })

  it('criteria 9, 17: nothing is built or sent without a validated code', async () => {
    const { flow, calls } = harness()
    await expect(flow.prepare(false)).rejects.toThrow(/validated code/)
    await expect(flow.upload()).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('criterion 17: an invalid code stops at validation with the generic message', async () => {
    const { flow, calls } = harness({ post: vi.fn(async () => new Response('{"error":"invalid_or_expired"}', { status: 403 })) })
    await expect(flow.validate(CODE)).rejects.toMatchObject({ kind: 'invalid_or_expired' })
    await expect(flow.prepare(false)).rejects.toThrow()
    expect(calls.filter((c) => !c.startsWith('POST'))).toEqual([])
  })

  it('criteria 9, 20: building shows a size; cancelling or Not now uploads and sends nothing', async () => {
    const { flow, calls, kept } = harness()
    await flow.validate(CODE)
    const { size } = await flow.prepare(false)
    expect(size).toBeGreaterThan(100)
    await flow.notNow()
    expect(calls).toEqual(['POST /api/v1/support/snapshot-codes/validate'])
    expect(kept.size).toBe(1)
    expect(readRecords(SELF)[0].state).toBe('kept')
    // Once the code expires the kept snapshot is deleted.
    expect(expireKept(SELF, NOW / 1000 + 72 * 3600 + 1)).toHaveLength(1)
    expect(readRecords(SELF)[0].state).toBe('expired')
  })

  it('criterion 20: Wi-Fi advice unless the connection is known to be Wi-Fi', () => {
    expect(connectionAdvice(4_400_000, { kind: 'wifi', saveData: false }).text).toBe("You're on Wi-Fi.")
    expect(connectionAdvice(4_400_000, { kind: 'unknown', saveData: false }).text).toMatch(/about 4\.2 MB.*consider connecting to Wi-Fi/)
    expect(connectionAdvice(4_400_000, { kind: 'cellular', saveData: false }).tone).toBe('warn')
    expect(connectionAdvice(4_400_000, { kind: 'wifi', saveData: true }).tone).toBe('warn')
  })

  it('criterion 19 (wallet side): a 403 from the edge is reported and no DM is sent', async () => {
    const { flow, calls } = harness({ fetch: vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch })
    await flow.validate(CODE)
    await flow.prepare(false)
    await expect(flow.upload()).rejects.toMatchObject({ status: 403 })
    expect(calls.some((c) => c.startsWith('DM'))).toBe(false)
  })

  it('criterion 7: the ack DM moves the record to deleted', async () => {
    const { flow } = harness()
    await flow.validate(CODE)
    await flow.prepare(false)
    const dm = await flow.upload()
    expect(applyAck(SELF, JSON.stringify({ type: 'imani-support-snapshot-ack', v: 1, sha256: dm.sha256, deleted: true, ticket: 'T1042' }))?.state).toBe('deleted')
    expect(applyAck(SELF, JSON.stringify({ type: 'imani-support-snapshot-ack', sha256: 'ff'.repeat(32) }))).toBeNull()
  })
})

describe('criterion 13: config hides the feature when unset', () => {
  const npub = nip19.npubEncode(SUPPORT)
  it('reads url, npub and ttl', () => {
    expect(parseSupportSnapshot({ support_blossom_url: 'http://localhost:28090/', support_npub: npub, support_blossom_ttl_seconds: 172800 }))
      .toEqual({ blossomUrl: 'http://localhost:28090', supportPubkey: SUPPORT, ttlSeconds: 172800 })
  })
  it('either missing hides it', () => {
    expect(parseSupportSnapshot({ support_npub: npub })).toBeNull()
    expect(parseSupportSnapshot({ support_blossom_url: 'http://x' })).toBeNull()
    expect(parseSupportSnapshot({ support_blossom_url: 'http://x', support_npub: 'nsec1xyz' })).toBeNull()
    expect(parseSupportSnapshot({})).toBeNull()
  })
})
