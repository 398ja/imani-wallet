import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #301 review: a redemption that gave up on the receive pacer (#300) throws a
 * quiet RECEIVE_DEFERRED, and dm-poll keeps the delivery unprocessed "for the
 * next poll". In SSE mode there is no timed poll: the next offer was the
 * stream's redial, up to ten minutes later, with the customer at the counter.
 * The adapter now schedules one catch-up shortly after.
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
vi.mock('../unsavedReceipt', () => ({ announceUnsaved: vi.fn(), resumeUnsavedReceipts: vi.fn(), listUnsavedReceipts: () => [], dropAcknowledgedReceipts: vi.fn(async () => 0) }))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../merchant', () => ({ loadMerchant: () => null }))
vi.mock('../attestation', () => ({ attestRedemption: async () => {}, nullifierFor: (t: string) => t }))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => {},
  withCorrelation: async (_c: unknown, fn: () => unknown) => fn(),
}))
vi.mock('../wallet', () => ({ getWallet: () => ({}), notifyWalletChanged: () => {} }))
vi.mock('../paymentReceipt', () => ({ postPaymentReceipt: async () => {} }))
vi.mock('../redemptionLedger', () => ({
  checkRedemption: async () => ({ allowed: true, alreadyRedeemed: 0, signedFaceValue: 0 }),
  redeemLockName: (voucherId: string) => `imani-redeem:${voucherId}`,
}))
vi.mock('../dmCrypto', () => ({ createDmCryptoAdapter: () => ({}), toLegacyMetadata: (m: unknown) => m }))
vi.mock('../trustedMint', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadTrustedMints: async () => {},
}))

const fetchRecentDms = vi.fn(async () => [])
let captured: { redemptionAdapter?: { redeem: (t: string, o?: unknown) => Promise<unknown> } } = {}
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: (config: typeof captured) => {
    captured = config
    return { start: async () => {}, stop: () => {}, fetchRecentDms }
  },
}))

vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })

const { startDmPoll, stopDmPoll, DEFERRED_RETRY_MS, MAX_DEFERRED_RETRIES_PER_TOKEN } = await import('../dmPoll')
const { _setReceivePacerForTests } = await import('../receivePacer')

const redeem = vi.fn()
const gateTimeout = () =>
  Object.assign(new Error('Receive pacer did not free a slot in time'), {
    code: 'RECEIVE_DEFERRED',
    deferredBy: 'receive-gate-timeout',
  })

beforeEach(() => {
  vi.useFakeTimers()
  stopDmPoll()
  redeem.mockReset()
  vi.stubGlobal('window', { TokenRedemption: { redeem }, addEventListener: () => {}, removeEventListener: () => {} })
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  stopDmPoll()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function deferOnce(token = 'cashuAtoken'): Promise<unknown> {
  redeem.mockRejectedValueOnce(gateTimeout())
  return captured.redemptionAdapter!.redeem(token, { metadata: {} }).catch((e: unknown) => e)
}

describe('#301 review: a receive-gate deferral is retried soon, not at the next SSE redial', () => {
  it('rethrows the deferral unchanged (dm-poll keeps it quiet and unprocessed)', async () => {
    startDmPoll('f'.repeat(64))
    const err = (await deferOnce()) as { code?: string }
    expect(err.code).toBe('RECEIVE_DEFERRED')
  })

  it('schedules one catch-up after DEFERRED_RETRY_MS, coalescing a burst', async () => {
    startDmPoll('f'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    fetchRecentDms.mockClear()
    await deferOnce()
    await deferOnce()
    await vi.advanceTimersByTimeAsync(DEFERRED_RETRY_MS - 1)
    expect(fetchRecentDms).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchRecentDms).toHaveBeenCalledTimes(1)
  })

  it('never re-polls after a logout in between', async () => {
    startDmPoll('f'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    fetchRecentDms.mockClear()
    await deferOnce()
    const armed = vi.getTimerCount()
    stopDmPoll()
    // The timer itself is cleared, not just made harmless by the poller guard.
    expect(vi.getTimerCount()).toBeLessThan(armed)
    await vi.advanceTimersByTimeAsync(DEFERRED_RETRY_MS * 2)
    expect(fetchRecentDms).not.toHaveBeenCalled()
  })

  it('an ordinary deferral (budget spent, pacer reset) schedules nothing', async () => {
    startDmPoll('f'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    fetchRecentDms.mockClear()
    redeem.mockRejectedValueOnce(Object.assign(new Error('budget spent'), { code: 'RECEIVE_DEFERRED' }))
    await captured.redemptionAdapter!.redeem('cashuAtoken', { metadata: {} }).catch(() => {})
    await vi.advanceTimersByTimeAsync(DEFERRED_RETRY_MS * 2)
    expect(fetchRecentDms).not.toHaveBeenCalled()
  })

  it('is bounded per token: a pacer that never frees cannot re-poll forever (#301 second check)', async () => {
    startDmPoll('f'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    fetchRecentDms.mockClear()
    for (let i = 0; i < MAX_DEFERRED_RETRIES_PER_TOKEN + 3; i++) {
      await deferOnce('cashuAstuck')
      await vi.advanceTimersByTimeAsync(DEFERRED_RETRY_MS)
    }
    expect(fetchRecentDms).toHaveBeenCalledTimes(MAX_DEFERRED_RETRIES_PER_TOKEN)
    // Another token still gets its own early retry.
    await deferOnce('cashuAother')
    await vi.advanceTimersByTimeAsync(DEFERRED_RETRY_MS)
    expect(fetchRecentDms).toHaveBeenCalledTimes(MAX_DEFERRED_RETRIES_PER_TOKEN + 1)
  })

  it('a logout resets the per-token count for the next session', async () => {
    startDmPoll('f'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < MAX_DEFERRED_RETRIES_PER_TOKEN; i++) {
      await deferOnce('cashuAstuck')
      await vi.advanceTimersByTimeAsync(DEFERRED_RETRY_MS)
    }
    stopDmPoll()
    startDmPoll('f'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    fetchRecentDms.mockClear()
    await deferOnce('cashuAstuck')
    await vi.advanceTimersByTimeAsync(DEFERRED_RETRY_MS)
    expect(fetchRecentDms).toHaveBeenCalledTimes(1)
  })

  it('the installed receive gate hands the abort signal to the pacer (no ghost slot)', async () => {
    const acquire = vi.fn(async () => {})
    const previous = _setReceivePacerForTests({ acquire, reset: () => {} })
    try {
      startDmPoll('f'.repeat(64))
      const win = window as unknown as { TokenRedemption: { _receiveGate?: (s?: AbortSignal) => Promise<void> } }
      redeem.mockResolvedValueOnce({ id: 'v' })
      await captured.redemptionAdapter!.redeem('cashuAok', { metadata: {} }).catch(() => {})
      const signal = new AbortController().signal
      await win.TokenRedemption._receiveGate!(signal)
      expect(acquire).toHaveBeenCalledWith(expect.any(Number), signal)
    } finally {
      _setReceivePacerForTests(previous)
    }
  })
})
