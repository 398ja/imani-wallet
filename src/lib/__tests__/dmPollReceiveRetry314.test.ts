import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #314: the till's amber strip says "The wallet will keep trying", and it did not. dm-poll keeps a
 * failed delivery behind a one-hour cooldown, and in SSE mode nothing re-polls on a timer, so a
 * coupon whose receive failed (S5: a NIP-98 window 401) arrived only in the merchant's NEXT
 * session. The poller now tries a failed receive again in this session, on a bounded backoff, and
 * never once logout has started (#331/#340/#353): deferred, never lost.
 */

vi.mock('../arrivalToast', () => ({
  announceArrival: () => {},
  announceBundleArrival: async () => {},
  resumeBundleArrivals: () => {},
  stopBundleArrivals: () => {},
}))
vi.mock('../heldToast', () => ({ announceHeld: () => {} }))
vi.mock('../notMoneyNotice', () => ({ licenceNotice: () => ({}), showNotice: () => {} }))
vi.mock('../refusalToast', () => ({ announceRefusal: vi.fn() }))
vi.mock('../unsavedReceipt', () => ({ announceUnsaved: vi.fn(), resumeUnsavedReceipts: vi.fn() }))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../merchant', () => ({ loadMerchant: () => null }))
vi.mock('../attestation', () => ({ attestRedemption: async () => {}, nullifierFor: (t: string) => t }))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => {},
  withCorrelation: async (_c: unknown, fn: () => unknown) => fn(),
}))
vi.mock('../wallet', () => ({ getWallet: () => ({}), notifyWalletChanged: () => {} }))
vi.mock('../paymentReceipt', () => ({ postPaymentReceipt: async () => {} }))
vi.mock('../dmCrypto', () => ({ createDmCryptoAdapter: () => ({}), toLegacyMetadata: (m: unknown) => m }))
vi.mock('../trustedMint', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadTrustedMints: async () => {},
}))

type Listener = (event: unknown) => void
const listeners = new Map<string, Listener[]>()
const failed = new Set<string>()
const replayEvent = vi.fn<(id: string) => Promise<boolean>>(async () => false)
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: () => ({
    start: async () => {},
    stop: () => {},
    fetchRecentDms: async () => [],
    on: (name: string, fn: Listener) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    replayEvent,
    getFailedEvents: () => [...failed].map((eventId) => ({ eventId })),
  }),
}))

vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true })

const { startDmPoll, stopDmPoll, RECEIVE_RETRY_BACKOFFS_MS } = await import('../dmPoll')
const { closeReceives, openReceives } = await import('../receiveGate')

const PUBKEY = 'f'.repeat(64)

function emitError(eventId: string, retryable?: boolean): void {
  failed.add(eventId)
  for (const fn of listeners.get('redemption:error') ?? []) {
    fn({ eventId, message: 'x', error: new Error('x'), token: 't', ...(retryable === undefined ? {} : { retryable }) })
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  stopDmPoll()
  listeners.clear()
  failed.clear()
  replayEvent.mockReset()
  replayEvent.mockImplementation(async () => false)
  openReceives()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  stopDmPoll()
  openReceives()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a failed receive is tried again in this session (#314)', () => {
  // Red on main: nothing re-offered the delivery until the next session.
  it('re-offers the delivery after the first backoff, and stops once it is received', async () => {
    startDmPoll(PUBKEY)
    replayEvent.mockImplementation(async (id: string) => {
      failed.delete(id)
      return true
    })
    emitError('e1')

    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS[0] - 1)
    expect(replayEvent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(replayEvent).toHaveBeenCalledWith('e1')

    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS.reduce((a, b) => a + b, 0))
    expect(replayEvent).toHaveBeenCalledTimes(1)
  })

  // Bounded: one try per backoff step, then it waits for the ordinary offers (next session).
  it('backs off and gives up after the last step', async () => {
    startDmPoll(PUBKEY)
    emitError('e1')
    for (const ms of RECEIVE_RETRY_BACKOFFS_MS) await vi.advanceTimersByTimeAsync(ms)
    expect(replayEvent).toHaveBeenCalledTimes(RECEIVE_RETRY_BACKOFFS_MS.length)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(replayEvent).toHaveBeenCalledTimes(RECEIVE_RETRY_BACKOFFS_MS.length)
  })

  // A repeat of the same failure (the retry's own error event) does not start a second chain.
  it('runs one chain per delivery', async () => {
    startDmPoll(PUBKEY)
    replayEvent.mockImplementation(async (id: string) => {
      emitError(id) // what dm-poll does on a failed replay
      return false
    })
    emitError('e1')
    emitError('e1')
    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS[0])
    expect(replayEvent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS[1])
    expect(replayEvent).toHaveBeenCalledTimes(2)
  })

  // A refusal dm-poll will never retry (the mint can never accept the token) is not retried here.
  it('does not retry a permanent refusal', async () => {
    startDmPoll(PUBKEY)
    emitError('e1', false)
    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS.reduce((a, b) => a + b, 0))
    expect(replayEvent).not.toHaveBeenCalled()
  })
})

describe('no retry once logout has started (#331/#340/#353)', () => {
  // Logout closes the receive gate before it stops the poller. A retry due in that gap must not
  // swap into a wallet being torn down; the delivery stays for the next session.
  it('a retry due after the receive gate closed does nothing', async () => {
    startDmPoll(PUBKEY)
    emitError('e1')
    closeReceives()
    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS.reduce((a, b) => a + b, 0))
    expect(replayEvent).not.toHaveBeenCalled()
  })

  it('stopping the poller clears every pending retry', async () => {
    startDmPoll(PUBKEY)
    emitError('e1')
    emitError('e2')
    const armed = vi.getTimerCount()
    stopDmPoll()
    expect(vi.getTimerCount()).toBeLessThanOrEqual(armed - 2)
    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS.reduce((a, b) => a + b, 0))
    expect(replayEvent).not.toHaveBeenCalled()
  })

  // Review of #314: a redeem already in flight when the poller stopped can report its failure
  // AFTER stopDmPoll cleared the timers. That late error must not arm a retry, and above all not
  // one that runs on the next account's poller. Red when the chain binds to whichever poller is
  // current at schedule time instead of the one that emitted the error.
  it('a late failure from a stopped poller does not arm a retry under the next one', async () => {
    startDmPoll(PUBKEY)
    const previous = [...(listeners.get('redemption:error') ?? [])]
    stopDmPoll()
    listeners.clear()
    startDmPoll('e'.repeat(64))
    failed.add('e1')
    for (const fn of previous) fn({ eventId: 'e1', message: 'x', error: new Error('x'), token: 't' })
    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS.reduce((a, b) => a + b, 0))
    expect(replayEvent).not.toHaveBeenCalled()
  })

  it('a retry from the previous session never runs under the next one', async () => {
    startDmPoll(PUBKEY)
    emitError('e1')
    stopDmPoll()
    startDmPoll('e'.repeat(64))
    await vi.advanceTimersByTimeAsync(RECEIVE_RETRY_BACKOFFS_MS.reduce((a, b) => a + b, 0))
    expect(replayEvent).not.toHaveBeenCalled()
  })
})
