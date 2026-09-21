/**
 * The received-token set: a memory mirror over localStorage.
 *
 * `hasTokenBeenReceived` runs once per event in the poll loop and used to
 * re-parse the entire set from storage each time, which was the dominant cost
 * of a catch-up (~1.8s of blocking parse over 2000 events against a 5000-entry
 * set). These tests cover what the mirror must not break in exchange.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startDmPoll, stopDmPoll, resetReceivedCache } from '../dmPoll'

const fake = vi.hoisted(() => ({ fetchRecentDms: vi.fn(async () => []) }))
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: vi.fn((config: unknown) => {
    captured.config = config
    return { ...fake, start: async () => {}, stop: () => {}, on: () => {} }
  }),
}))

const captured: { config?: unknown } = {}

/** The storage adapter dm-poll was actually constructed with. */
function adapter() {
  return (captured.config as { storageAdapter: {
    hasTokenBeenReceived(f: string): Promise<boolean>
    markTokenAsReceived(f: string): Promise<void>
  } }).storageAdapter
}

class FakeEventSource {
  static readonly CLOSED = 2
  readyState = 1
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

const RECEIVED_KEY = 'imani-wallet:dm-poll:received'
const PUBKEY_A = 'a'.repeat(64)
const PUBKEY_B = 'b'.repeat(64)

describe('the received-token mirror', () => {
  beforeEach(() => {
    localStorage.clear()
    resetReceivedCache()
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    stopDmPoll()
    localStorage.clear()
  })

  it('reads what a previous session wrote', async () => {
    localStorage.setItem(RECEIVED_KEY, JSON.stringify(['banked-last-week']))

    startDmPoll(PUBKEY_A)

    // The mirror loads lazily from storage, so a coupon banked before this
    // session must still be recognised -- otherwise the wallet re-offers a
    // spent token to the mint on every poll.
    expect(await adapter().hasTokenBeenReceived('banked-last-week')).toBe(true)
    expect(await adapter().hasTokenBeenReceived('never-seen')).toBe(false)
  })

  it('still persists, so the next session sees it', async () => {
    startDmPoll(PUBKEY_A)
    await adapter().markTokenAsReceived('fresh-coupon')

    // The write stays synchronous: this is the first line of defence against
    // crediting a coupon twice, and it must survive a crash.
    expect(JSON.parse(localStorage.getItem(RECEIVED_KEY)!)).toContain('fresh-coupon')
  })

  it('does not answer one account from another account\'s memory', async () => {
    startDmPoll(PUBKEY_A)
    await adapter().markTokenAsReceived('account-a-coupon')

    // An identity change restarts the poller. A mirror left loaded would tell
    // the next user their coupon was already banked and silently drop it.
    localStorage.clear()
    startDmPoll(PUBKEY_B)

    expect(await adapter().hasTokenBeenReceived('account-a-coupon')).toBe(false)
  })

  it('bounds a set that used to grow for the life of the wallet', async () => {
    startDmPoll(PUBKEY_A)

    // Every coupon ever banked was kept forever, and the whole set was
    // re-serialised on each addition, so a busy stall got permanently slower
    // at receiving money.
    for (let i = 0; i < 2050; i += 1) {
      await adapter().markTokenAsReceived(`coupon-${i}`)
    }

    const stored = JSON.parse(localStorage.getItem(RECEIVED_KEY)!) as string[]
    expect(stored.length).toBe(2000)

    // Oldest evicted, newest kept. An evicted fingerprint costs one mint round
    // trip that fails safely; it is never a coupon credited twice.
    expect(stored).not.toContain('coupon-0')
    expect(stored).toContain('coupon-2049')
  })

  it('does not rewrite storage for a fingerprint it already holds', async () => {
    startDmPoll(PUBKEY_A)
    await adapter().markTokenAsReceived('same-coupon')

    const spy = vi.spyOn(Storage.prototype, 'setItem')
    await adapter().markTokenAsReceived('same-coupon')

    // Re-marking is common: dm-poll marks on the already-redeemed path too.
    // Serialising the whole set again to add nothing is pure cost.
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('keeps working when storage refuses the write', async () => {
    startDmPoll(PUBKEY_A)
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A full quota must not throw into dm-poll's redemption path: the coupon
    // has already been swapped at the mint by the time this runs.
    await expect(adapter().markTokenAsReceived('coupon')).resolves.toBeUndefined()

    spy.mockRestore()

    // And the mirror still dedupes for the rest of the session.
    expect(await adapter().hasTokenBeenReceived('coupon')).toBe(true)
  })

  it('retries a write that storage refused, once storage recovers', async () => {
    startDmPoll(PUBKEY_A)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await adapter().markTokenAsReceived('coupon')
    spy.mockRestore()

    // The fingerprint is in memory but NOT on disk. Skipping the write on the
    // memory hit alone would strand it there for the life of the session, so
    // the coupon would be re-offered to the mint in every future session --
    // the exact cost this set exists to avoid.
    await adapter().markTokenAsReceived('coupon')

    expect(JSON.parse(localStorage.getItem(RECEIVED_KEY)!)).toContain('coupon')
  })

  it('trims an oversized legacy set at load, not at the next receive', async () => {
    // Every wallet upgrading to this build carries a set written while it was
    // unbounded.
    const legacy = Array.from({ length: 50000 }, (_, i) => `old-${i}`)
    localStorage.setItem(RECEIVED_KEY, JSON.stringify(legacy))

    startDmPoll(PUBKEY_A)

    // Reading is enough to trim it: the cost lands at poller startup, where
    // nothing is waiting, instead of on the first coupon to arrive. Before
    // this, that first receive paid ~400ms of synchronous work with a
    // customer standing at the counter.
    await adapter().hasTokenBeenReceived('anything')

    const stored = JSON.parse(localStorage.getItem(RECEIVED_KEY)!) as string[]
    expect(stored.length).toBe(2000)
    // The NEWEST survive, matching the oldest-first eviction on the write path.
    expect(stored).toContain('old-49999')
    expect(stored).not.toContain('old-0')
  })
})
