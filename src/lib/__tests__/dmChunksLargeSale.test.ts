/**
 * The fixes for a large sale that delivered nothing and then wedged the wallet.
 *
 * Four independent defects, all on the receive path, all reachable only once a
 * sale is big enough to be split and chunked. Each test here is one of them,
 * and each fails on the build that shipped the outage.
 *
 * jsdom, for `localStorage`: the completed-transfer set is persisted now, and
 * the reload case is the whole point of two of these tests. A `node` run is
 * covered separately, in `dmChunksNoStorage.test.ts` -- the module must also
 * work where there is no storage at all.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import {
  asChunk,
  looksLikeChunk,
  offerChunk,
  pendingChunkTransfers,
  resetChunkAssembly,
} from '../dmChunks'

/** The envelopes a gateway would send for one payload split `total` ways. */
function envelopes(payload: string, total: number, transferId = 'transfer-1'): string[] {
  const bytes = new TextEncoder().encode(payload)
  const b64 = Buffer.from(bytes).toString('base64')
  const per = Math.ceil(b64.length / total)
  return Array.from({ length: total }, (_, i) =>
    JSON.stringify({
      type: 'cashu_dm_chunk',
      version: '1.0',
      payload_type: 'cashu_token_transfer',
      payload_version: '1.0',
      transfer_id: transferId,
      chunk_index: i,
      chunk_total: total,
      content_encoding: 'identity',
      content_length: bytes.length,
      content_sha256: bytesToHex(sha256(bytes)),
      payload: b64.slice(i * per, (i + 1) * per),
    }),
  )
}

/** A coupon payload of roughly the size a large sale actually produces. */
function couponOf(tokenChars: number): string {
  return JSON.stringify({ type: 'cashu_token_transfer', token: 'cashuA'.repeat(tokenChars) })
}

describe('receiving a large, heavily chunked coupon', () => {
  beforeEach(() => {
    localStorage.clear()
    resetChunkAssembly()
  })

  it('reassembles a transfer split into more than 16 pieces', async () => {
    // The old ceiling was 16, taken from one deployment's `max_chunks` and
    // enforced as though it were a protocol constant. A 1000-unit sale mints
    // the largest tokens the system produces, which is exactly when a sender
    // exceeds it -- and every piece was then refused, so the coupon could
    // never be rebuilt from any number of retries.
    const payload = couponOf(3000)
    const parts = envelopes(payload, 24)

    let whole: string | null = null
    for (const raw of parts) {
      const chunk = asChunk(raw)
      expect(chunk).not.toBeNull()
      whole = await offerChunk(chunk!)
    }

    expect(whole).toBe(payload)
  })

  it('still refuses a transfer beyond the hard ceiling', async () => {
    // Raised, not removed. The bound that matters is on bytes, but the count
    // is still checked so a sender cannot open unbounded pending entries.
    for (const raw of envelopes(couponOf(10), 65)) {
      expect(asChunk(raw)).toBeNull()
    }
  })

  it('tells a refused chunk apart from a DM that was never a chunk', () => {
    // This distinction is what keeps a refusal retryable. `asChunk` answers
    // null for both, so the receive path cannot use it to decide whether an
    // event may be marked processed and discarded forever.
    const refused = envelopes(couponOf(10), 65)[0]
    expect(asChunk(refused)).toBeNull()
    expect(looksLikeChunk(refused)).toBe(true)

    expect(looksLikeChunk('🎁 Token Transfer: 1.00 USD')).toBe(false)
    expect(looksLikeChunk(JSON.stringify({ type: 'cashu_token_transfer' }))).toBe(false)
    expect(looksLikeChunk('not json at all')).toBe(false)
  })

  it('does not re-hold a completed transfer after a reload', async () => {
    const parts = envelopes(couponOf(400), 5).map((raw) => asChunk(raw)!)

    for (const chunk of parts) await offerChunk(chunk)
    expect(pendingChunkTransfers()).toBe(0)

    // A RELOAD, not a sign-out: every module-level Map is dropped and rebuilt
    // from storage. `resetChunkAssembly` cannot stand in for this, because it
    // deliberately clears the durable copy as well.
    //
    // The processed-event tombstones survive a reload too -- they are in
    // localStorage -- and they cover only the ONE event that completed this
    // transfer. So the other four wraps come back on the next poll with no
    // sibling that could ever finish them.
    vi.resetModules()
    const reloaded = await import('../dmChunks')

    for (const chunk of parts.slice(0, 4)) {
      expect(await reloaded.offerChunk(chunk)).toBeNull()
    }

    // Before the completed set was persisted this was 1: a pending entry
    // holding 4 of 5, rebuilt on every poll for the life of the fetch window,
    // logging a "holding chunk" line each time for a coupon already banked.
    expect(reloaded.pendingChunkTransfers()).toBe(0)
  })

  it('remembers a completed transfer for longer than the poll fetch window', async () => {
    const parts = envelopes(couponOf(400), 4).map((raw) => asChunk(raw)!)
    const t0 = Date.now()
    for (const chunk of parts) await offerChunk(chunk, t0)

    // `dmPoll` re-reads a 7-day window, so a guard that expires at 24h left
    // six days in which stragglers re-opened an uncompletable entry.
    const sixDaysOn = t0 + 6 * 24 * 60 * 60 * 1000
    expect(await offerChunk(parts[0], sixDaysOn)).toBeNull()
    expect(pendingChunkTransfers()).toBe(0)
  })

  it('bounds how many transfers may be half-assembled at once', async () => {
    // Each entry holds DECRYPTED fragments of someone's money for the full
    // 10-minute TTL. The per-transfer byte ceiling bounds one of these; until
    // this cap, nothing bounded how many could be open together, so the real
    // exposure was that budget times however many transfer_ids a sender cared
    // to mention. Raising the per-transfer budget raised that product too.
    const first = 'transfer-0'
    for (let i = 0; i < 200; i += 1) {
      const chunk = asChunk(
        JSON.stringify({
          type: 'cashu_dm_chunk',
          transfer_id: `transfer-${i}`,
          // One piece of eight: this transfer never completes.
          chunk_index: 0,
          chunk_total: 8,
          content_encoding: 'identity',
          content_length: 10,
          content_sha256: 'ab'.repeat(32),
          payload: 'aGVsbG8=',
        }),
      )
      await offerChunk(chunk!)
    }

    expect(pendingChunkTransfers()).toBe(64)

    // The OLDEST was evicted, not the newest: a transfer still arriving is
    // worth more than one that has sat unfinished the longest.
    const revived = asChunk(
      JSON.stringify({
        type: 'cashu_dm_chunk',
        transfer_id: first,
        chunk_index: 1,
        chunk_total: 8,
        content_encoding: 'identity',
        content_length: 10,
        content_sha256: 'ab'.repeat(32),
        payload: 'aGVsbG8=',
      }),
    )
    await offerChunk(revived!)

    // Evicting cost nothing permanent: none of its wraps were marked
    // processed, so it simply starts assembling again.
    expect(pendingChunkTransfers()).toBe(64)
  })

  it('does not resurrect a signed-out account\'s transfers', async () => {
    const parts = envelopes(couponOf(400), 3).map((raw) => asChunk(raw)!)
    for (const chunk of parts) await offerChunk(chunk)

    // Completion queues a DEFERRED write. Signing out clears the store, and
    // the queued write must not then land and put the ids back -- on a shared
    // device, after the user believes they have left.
    resetChunkAssembly()
    await new Promise((r) => setTimeout(r, 5))

    expect(localStorage.getItem('imani-wallet:dm-chunks:completed')).toBeNull()
  })
})
