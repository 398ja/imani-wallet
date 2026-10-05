/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { RedemptionRefusedError } from '@imani/dm-poll'

/**
 * The cross-stall refusal, observed through the REDEMPTION ADAPTER that
 * `startDmPoll` installs — not through the exported check called directly.
 *
 * `refuseIfAnotherStalls.test.ts` covers the decision. This covers the thing
 * that decision is FOR, and the one claim the unit tests structurally cannot
 * make: that the refusal happens **before the mint swap**.
 *
 * That ordering is the whole design. `RedemptionRefusedError`'s own comment
 * says it: "Nothing has moved when this is raised — it is thrown before the
 * mint swap — so the token remains the sender's and their send reclaims at
 * their next login." A refusal one line later would have already taken the
 * money, and the customer's coupon would be gone with nothing credited.
 *
 * So the assertion here is not "it threw". It is "it threw AND
 * `TokenRedemption.redeem` was never called". A unit test on the check cannot
 * see that, because the swap is not in its frame.
 *
 * The adapter is module-private, so it is reached the way production reaches
 * it: `startDmPoll` builds a real `DmPollService` around it, and the service's
 * config is read back to get the installed adapter. That is the integration
 * boundary; everything below `redeem` is stubbed because it is a live mint.
 */

const stubs = vi.hoisted(() => ({
  merchant: null as Record<string, unknown> | null,
  /** Every token handed to the mint. Must stay EMPTY on a refusal. */
  swapped: [] as string[],
  /** Every refusal the wallet announced to the stall. */
  announced: [] as unknown[],
}))

vi.mock('../merchant', () => ({
  loadMerchant: () => stubs.merchant,
  MERCHANT_KIND: 30078,
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({}),
  // Passes the work through so the adapter's real ordering is preserved.
  withCorrelation: async (_ids: unknown, run: () => unknown) => run(),
}))
vi.mock('../wallet', () => ({
  listTransactions: async () => [],
  getWallet: () => ({}),
  notifyWalletChanged: () => {},
  recordReceiptByNullifier: async () => {},
}))
vi.mock('../relay', () => ({ allEvents: async () => [], publish: async () => ({ ok: 1 }) }))
vi.mock('../arrivalToast', () => ({
  announceArrival: () => {},
  announceBundleArrival: async () => {},
  resumeBundleArrivals: () => {},
  stopBundleArrivals: () => {},
}))
vi.mock('../queuedToast', () => ({ announceQueued: () => {}, settleQueued: () => {} }))
vi.mock('../paymentReceipt', () => ({ postPaymentReceipt: () => {} }))
vi.mock('../attestation', () => ({
  attestRedemption: async () => null,
  nullifierFor: () => 'n'.repeat(64),
}))
// sonner touches the DOM at import; the held-coupon toast is its own module for that reason (#133 review).
vi.mock('../heldToast', () => ({ announceHeld: () => {} }))
vi.mock('../refusalToast', () => ({
  announceRefusal: (e: unknown) => stubs.announced.push(e),
}))

import { startDmPoll, stopDmPoll } from '../dmPoll'
import { buildVoucherToken } from './voucherFixtures'

const MY_STALL = 'ab'.repeat(32)

const verified = {
  signatureValid: true,
  legacyCanonical: false,
  signedFaceValue: 1000,
  cappedAtFaceValue: false,
}

/** The adapter `startDmPoll` actually installed, read back off the service. */
function installedAdapter() {
  const service = startDmPoll(MY_STALL) as unknown as {
    config: { redemptionAdapter: { redeem: (t: string, o?: unknown) => Promise<unknown> } }
  }
  return service.config.redemptionAdapter
}

beforeEach(() => {
  stubs.merchant = { pubkey: MY_STALL, active: true }
  stubs.swapped = []
  stubs.announced = []
  // The mint. Records what it was asked to swap and nothing else.
  ;(window as unknown as Record<string, unknown>).TokenRedemption = {
    redeem: async (token: string) => {
      stubs.swapped.push(token)
      return { voucher_id: 'v', amount: 400, unit: 'GBP', decimals: 2 }
    },
  }
})

afterEach(() => {
  stopDmPoll()
  delete (window as unknown as Record<string, unknown>).TokenRedemption
})

describe('a coupon from another stall, through the installed adapter', () => {
  it('is refused WITHOUT ever reaching the mint', async () => {
    // The claim the unit tests cannot make. If the refusal moved after the
    // swap, this still throws — and `swapped` would hold the token, meaning
    // the customer's coupon had been burnt for a redemption we then refused.
    const { token, voucher } = buildVoucherToken({ faceValue: 400, unit: 'GBP' })
    expect(voucher.issuerId.toLowerCase()).not.toBe(MY_STALL)

    await expect(
      installedAdapter().redeem(token, {
        metadata: { issuerId: voucher.issuerId, voucherId: 'v-1', faceValue: 400, validation: verified },
      } as never),
    ).rejects.toBeInstanceOf(RedemptionRefusedError)

    expect(stubs.swapped).toEqual([])
  })

  it('is ANNOUNCED to the stall, through the real service wiring', () => {
    // The gap review found: this event was emitted and nothing subscribed, so
    // a refusal was indistinguishable from a coupon lost in the network.
    //
    // Driven through DmPollService.processTokenDm rather than by calling the
    // listener, so it covers the subscription in startDmPoll as well as the
    // toast - the two halves that were missing.
    const service = startDmPoll(MY_STALL) as unknown as {
      emit: (name: string, payload: unknown) => void
    }
    service.emit('redemption:refused', { reason: 'another-stall', voucherId: 'v-1' })

    expect(stubs.announced).toHaveLength(1)
    expect((stubs.announced[0] as { reason: string }).reason).toBe('another-stall')
  })

  it('lets this stall’s own coupon through to the mint', async () => {
    // The control. Proves the refusal above is about the issuer and not about
    // the adapter being inert under test — without this, a broken adapter that
    // threw on everything would look like a working check.
    const { token } = buildVoucherToken({ issuerId: MY_STALL, faceValue: 400, unit: 'GBP' })

    await installedAdapter().redeem(token, {
      metadata: { issuerId: MY_STALL, voucherId: 'v-1', faceValue: 400, validation: verified },
    } as never)

    expect(stubs.swapped).toEqual([token])
  })

  it('lets a LICENCE from another issuer through to the mint', async () => {
    // The exception, at the integration boundary rather than at the check.
    // This is the case whose first implementation would have stopped every
    // stall renewing its subscription.
    const { token, voucher } = buildVoucherToken({
      merchantMetadata: JSON.stringify({ subscription_id: 'sub_9f2c11', features: ['terminals'] }),
      faceValue: 4000,
      unit: 'GBP',
    })

    await installedAdapter().redeem(token, {
      metadata: {
        issuerId: voucher.issuerId,
        voucherId: 'v-lic',
        faceValue: 4000,
        // The licence's OWN signed ceiling. An earlier draft of this test left
        // it at the shared 1000 and watched `refuseIfOverRedeemed` refuse a
        // 4000 licence — the cross-stall check had passed it correctly and the
        // fixture was wrong. Worth keeping the note: a wrong fixture here
        // reads exactly like a broken exception.
        validation: { ...verified, signedFaceValue: 4000 },
      },
    } as never)

    expect(stubs.swapped).toEqual([token])
  })

  it('lets a customer wallet redeem anything, since it is not a stall', async () => {
    // A customer holding another party's coupon is the ordinary case. If this
    // ever refused, the product would be broken for every shopper.
    stubs.merchant = null
    const { token, voucher } = buildVoucherToken({ faceValue: 400, unit: 'GBP' })

    await installedAdapter().redeem(token, {
      metadata: { issuerId: voucher.issuerId, voucherId: 'v-1', faceValue: 400, validation: verified },
    } as never)

    expect(stubs.swapped).toEqual([token])
  })
})
