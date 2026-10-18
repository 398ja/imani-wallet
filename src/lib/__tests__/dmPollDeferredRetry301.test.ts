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

const { startDmPoll, stopDmPoll, DEFERRED_RETRY_MS } = await import('../dmPoll')

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

async function deferOnce(): Promise<unknown> {
  redeem.mockRejectedValueOnce(gateTimeout())
  return captured.redemptionAdapter!.redeem('cashuAtoken', { metadata: {} }).catch((e: unknown) => e)
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
    stopDmPoll()
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
})
