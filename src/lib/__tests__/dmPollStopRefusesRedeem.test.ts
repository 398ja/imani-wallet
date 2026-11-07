import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Second check of #326 (owner rule 2026-10-18: logout only once every voucher
 * is verifiably backed up).
 *
 * Logout stops the poller and then waits for redemptions "in flight". But
 * `DmPollService.stop()` does not end a catch-up batch that is already looping
 * over gift wraps, so the batch's NEXT item still called `redeem` and swapped
 * at the mint, after the drain had answered "nothing in flight" and after the
 * wipe. The proofs were burnt and written nowhere. A stopped poller's adapter
 * now refuses before anything is swapped.
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

type Adapter = { redeem: (t: string, o?: unknown) => Promise<unknown> }
let captured: { redemptionAdapter?: Adapter } = {}
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: (config: typeof captured) => {
    captured = config
    return { start: async () => {}, stop: () => {}, fetchRecentDms: async () => [] }
  },
}))

vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
const redeem = vi.fn()
const stubWindow = () =>
  vi.stubGlobal('window', { TokenRedemption: { redeem }, addEventListener: () => {}, removeEventListener: () => {} })
stubWindow()

const { startDmPoll, stopDmPoll, drainDmPoll } = await import('../dmPoll')

const PK = 'f'.repeat(64)

beforeEach(() => {
  stubWindow()
  stopDmPoll()
  redeem.mockReset()
  redeem.mockResolvedValue({ id: 'v' })
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  stopDmPoll()
  vi.restoreAllMocks()
})

describe('a stopped poller cannot swap (second check of #326)', () => {
  it('the batch item after stopDmPoll is refused before the mint is asked, and stays retryable', async () => {
    startDmPoll(PK)
    const adapter = captured.redemptionAdapter!
    // The batch's first item ran before logout.
    await adapter.redeem('cashuAfirst', { metadata: {} })
    expect(redeem).toHaveBeenCalledTimes(1)

    // Logout: stop, then drain. Nothing is in flight between two items.
    stopDmPoll()
    expect(await drainDmPoll(10)).toBe(true)

    // The batch loop carries on with its next gift wrap.
    const err = (await adapter.redeem('cashuAsecond', { metadata: {} }).catch((e: unknown) => e)) as { code?: string }
    expect(err.code).toBe('RECEIVE_DEFERRED')
    expect(redeem).toHaveBeenCalledTimes(1)
  })

  it('the next poller (a refused logout restarts it) redeems normally', async () => {
    startDmPoll(PK)
    stopDmPoll()
    startDmPoll(PK)
    await captured.redemptionAdapter!.redeem('cashuAagain', { metadata: {} })
    expect(redeem).toHaveBeenCalledTimes(1)
  })
})

describe('a tab that let go of the store for another tab (review of #353)', () => {
  it('a poller started again afterwards (a resume from a refused logout) swaps nothing', async () => {
    const gate = await import('../receiveGate')
    try {
      gate.sealGates()
      startDmPoll(PK)
      const err = (await captured.redemptionAdapter!.redeem('cashuAlate', { metadata: {} }).catch((e: unknown) => e)) as {
        code?: string
      }
      expect(err.code).toBe('RECEIVE_DEFERRED')
      expect(redeem).not.toHaveBeenCalled()
    } finally {
      gate.unsealGatesForTests()
      gate.openReceives()
      gate.openSpends()
    }
  })
})
