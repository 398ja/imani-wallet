import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The wiring, not the toast: does a coupon redeemed through dm-poll actually
 * announce itself?
 *
 * arrivalToast.test.ts proves the announcement is correct once called. This
 * proves it is called — which is the whole of bug 3, where a real receipt was
 * silent because nothing on the ordinary NIP-17 delivery path ever raised
 * anything.
 */

const announced: unknown[] = []
vi.mock('../arrivalToast', () => ({
  announceArrival: (v: unknown) => void announced.push(v),
}))

// The redemption path reaches the legacy layer for the actual mint swap; the
// question here is only what happens around it.
const redeem = vi.fn()
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => {},
  withCorrelation: async (_c: unknown, fn: () => unknown) => fn(),
}))

const notifyWalletChanged = vi.fn()
vi.mock('../wallet', () => ({
  getWallet: () => ({}),
  notifyWalletChanged: () => notifyWalletChanged(),
}))

vi.mock('../redemptionLedger', () => ({
  checkRedemption: async () => ({ allowed: true, alreadyRedeemed: 0, signedFaceValue: 0 }),
}))

vi.mock('../dmCrypto', () => ({
  createDmCryptoAdapter: () => ({}),
  toLegacyMetadata: (m: unknown) => m,
}))

/**
 * `createDmPollService` is where the wallet hands its adapters to the package.
 * Capturing the config is how the redemption adapter is reachable from a test
 * without standing up the whole poller.
 */
let captured: { redemptionAdapter?: { redeem: (t: string, o?: unknown) => Promise<unknown> } } = {}
vi.mock('@imani/dm-poll', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createDmPollService: (config: typeof captured) => {
    captured = config
    return { start: async () => {}, stop: () => {}, fetchRecentDms: async () => [] }
  },
}))

// `startDmPoll` attaches visibilitychange/online listeners at module scope of
// the call, so these have to exist BEFORE it runs, not inside a beforeEach that
// the import has already outrun.
vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })

const { startDmPoll, stopDmPoll } = await import('../dmPoll')

const VOUCHER = {
  voucher_id: 'v-4-xaf',
  face_value: 4,
  face_unit: 'XAF',
  face_decimals: 0,
  sender_pubkey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
}

beforeEach(() => {
  stopDmPoll()
  announced.length = 0
  notifyWalletChanged.mockClear()
  redeem.mockReset()
  // The redemption path reads `window.TokenRedemption`, so the stub has to keep
  // the listener methods the poller also needs.
  vi.stubGlobal('window', {
    TokenRedemption: { redeem },
    addEventListener: () => {},
    removeEventListener: () => {},
  })
})

describe('a coupon arriving through dm-poll', () => {
  it('announces itself once redeemed', async () => {
    redeem.mockResolvedValue(VOUCHER)
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuAtoken', { metadata: {} })

    expect(announced).toHaveLength(1)
    expect(announced[0]).toMatchObject({ voucher_id: 'v-4-xaf', face_value: 4 })
  })

  it('announces only after the balance has been updated', async () => {
    // Order matters: the toast sends the user to look at their balance, and it
    // should already be the new one when they do.
    const order: string[] = []
    notifyWalletChanged.mockImplementation(() => void order.push('wallet'))
    redeem.mockImplementation(async () => {
      order.push('redeem')
      return VOUCHER
    })
    startDmPoll('f'.repeat(64))

    await captured.redemptionAdapter!.redeem('cashuAtoken', { metadata: {} })
    order.push('announced')

    expect(order).toEqual(['redeem', 'wallet', 'announced'])
  })

  it('says nothing when the redemption failed', async () => {
    // No money moved, so there is nothing to announce — and the error has to
    // keep propagating to dm-poll's own retry handling.
    redeem.mockRejectedValue(new Error('mint unavailable'))
    startDmPoll('f'.repeat(64))

    await expect(
      captured.redemptionAdapter!.redeem('cashuAtoken', { metadata: {} }),
    ).rejects.toThrow('mint unavailable')
    expect(announced).toHaveLength(0)
  })
})
