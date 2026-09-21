/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startDmPoll, stopDmPoll } from '../dmPoll'
import { offerChunk, resetChunkAssembly, pendingChunkTransfers } from '../dmChunks'

const fake = vi.hoisted(() => ({ fetchRecentDms: vi.fn(async () => []) }))
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: () => ({ ...fake, start: async () => {}, stop: () => {} }),
}))

/** Enough of an EventSource for `startDmPoll` to wire its SSE adapter. */
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = FakeEventSource.OPEN
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

/**
 * Recovering the coupons this wallet already gave up on.
 *
 * Shipping the reassembler does not, by itself, bring back the coupons lost
 * before it existed. A chunk that arrived earlier was classified
 * `non_token_dm`, whose decision is `shouldMarkProcessed: true` with
 * `retryEligible: false` — so the event id sits in the processed set and the
 * poller skips it for good. The gift wraps are still on the relay, so that
 * local tombstone is the only thing between the customer and their money.
 */
describe('amnesty for events abandoned before chunk reassembly existed', () => {
  const PROCESSED_KEY = 'imani-wallet:dm-poll:processed'
  const AMNESTY_KEY = 'imani-wallet:dm-poll:chunk-amnesty:v2'
  const LEGACY_AMNESTY_KEY = 'imani-wallet:dm-poll:chunk-amnesty'
  const PUBKEY = 'b'.repeat(64)

  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    stopDmPoll()
    localStorage.clear()
  })

  it('forgets the tombstones so the abandoned wraps are read again', () => {
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(['lost-chunk-a', 'lost-chunk-b']))

    startDmPoll(PUBKEY)

    // Still present, and the poller would skip the very events carrying the
    // customer's coupon.
    expect(localStorage.getItem(PROCESSED_KEY)).toBeNull()
  })

  it('runs only once, so later tombstones are honoured', () => {
    startDmPoll(PUBKEY)
    stopDmPoll()

    // Anything abandoned from now on was abandoned by code that CAN reassemble,
    // so it is a real decision and must stick.
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(['genuinely-not-a-token']))
    startDmPoll(PUBKEY)

    expect(JSON.parse(localStorage.getItem(PROCESSED_KEY)!)).toEqual([
      'genuinely-not-a-token',
    ])
  })

  it('leaves the received-token set alone', () => {
    // That set keys on the TOKEN fingerprint and is what actually prevents a
    // coupon being credited twice. Clearing it alongside the event ids would
    // turn a safe re-read into a double-redemption risk.
    const received = 'imani-wallet:dm-poll:received'
    localStorage.setItem(received, JSON.stringify(['fingerprint-of-a-spent-coupon']))
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(['old-event']))

    startDmPoll(PUBKEY)

    expect(JSON.parse(localStorage.getItem(received)!)).toEqual([
      'fingerprint-of-a-spent-coupon',
    ])
  })

  it('records that it ran, even with nothing to forget', () => {
    startDmPoll(PUBKEY)
    expect(localStorage.getItem(AMNESTY_KEY)).toBeTruthy()
  })

  it('runs again on a device that already took the FIRST amnesty', () => {
    // The exact state of every wallet affected by the 16-chunk ceiling: the v1
    // amnesty ran long ago for the pre-reassembly bug, so an unversioned
    // one-shot would decline to run and the coupons that ceiling abandoned
    // would stay tombstoned forever. Versioning the key is what lets a later
    // fix say "the tombstones written before me are not to be trusted".
    localStorage.setItem(LEGACY_AMNESTY_KEY, new Date().toISOString())
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(['chunk-refused-by-the-16-ceiling']))

    startDmPoll(PUBKEY)

    expect(localStorage.getItem(PROCESSED_KEY)).toBeNull()
    expect(localStorage.getItem(AMNESTY_KEY)).toBeTruthy()
    // The superseded marker is cleared, so the storage carries one answer.
    expect(localStorage.getItem(LEGACY_AMNESTY_KEY)).toBeNull()
  })
})

/**
 * Half-assembled coupons must not outlive the session that received them.
 *
 * A pending chunk is a DECRYPTED fragment of someone's money sitting in memory.
 * `startDmPoll` calls `stopDmPoll` on an identity change, so without an
 * explicit clear the previous account's pieces would still be in the assembly
 * map — and on logout they would simply persist. Found in review.
 */
describe('chunk assemblies do not survive the session', () => {
  const PUBKEY_A = 'c'.repeat(64)
  const PUBKEY_B = 'd'.repeat(64)

  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetChunkAssembly()
  })

  afterEach(() => {
    stopDmPoll()
    localStorage.clear()
  })

  it('drops pending pieces on logout', async () => {
    const chunk = {
      type: 'cashu_dm_chunk' as const,
      transfer_id: 'someones-coupon',
      chunk_index: 0,
      chunk_total: 2,
      content_encoding: 'identity' as const,
      content_length: 10,
      content_sha256: 'ab'.repeat(32),
      payload: 'aGVsbG8=',
    }
    startDmPoll(PUBKEY_A)
    await offerChunk(chunk)
    expect(pendingChunkTransfers()).toBe(1)

    stopDmPoll()
    expect(pendingChunkTransfers()).toBe(0)
  })

  it('does not carry one account\'s pieces into the next', async () => {
    const chunk = {
      type: 'cashu_dm_chunk' as const,
      transfer_id: 'account-a-coupon',
      chunk_index: 0,
      chunk_total: 2,
      content_encoding: 'identity' as const,
      content_length: 10,
      content_sha256: 'ab'.repeat(32),
      payload: 'aGVsbG8=',
    }
    startDmPoll(PUBKEY_A)
    await offerChunk(chunk)
    expect(pendingChunkTransfers()).toBe(1)

    // An identity change restarts the poller internally.
    startDmPoll(PUBKEY_B)
    expect(pendingChunkTransfers()).toBe(0)
  })
})
