import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RedemptionRefusedError } from '@imani/dm-poll'

/**
 * A coupon is a claim on ONE stall, and only that stall may honour it.
 *
 * The check these tests cover closes the gap recorded as Finding 1 in
 * docs/research/audit-double-spend-inflation-review.md: `wallet-api`'s
 * `verifyCoupon` had always refused another stall's coupon
 * (`REFUSAL.ANOTHER_STALL`) while the DM path — the one every real merchant
 * actually uses — did not.
 *
 * The failure was a LIVENESS bug before it was a fraud one, and the first test
 * below is the one that matters most: a customer at the wrong counter had their
 * coupon credited by a merchant who could never redeem it, and the merchant
 * silently absorbed the loss.
 */

const stubs = vi.hoisted(() => ({
  /** What `loadMerchant` answers. `null` means this wallet is a customer. */
  merchant: null as Record<string, unknown> | null,
}))

vi.mock('../merchant', () => ({
  loadMerchant: () => stubs.merchant,
  MERCHANT_KIND: 30078,
}))
vi.mock('../wallet', () => ({
  listTransactions: async () => [],
  getWallet: () => ({}),
  notifyWalletChanged: () => {},
}))
vi.mock('../legacyBridge', () => ({ legacyApi: async () => ({}), withCorrelation: vi.fn() }))

import { refuseIfAnotherStalls } from '../dmPoll'
import { buildVoucherToken } from './voucherFixtures'

const MY_STALL = 'ab'.repeat(32)
const OTHER_STALL = 'cd'.repeat(32)
const VOUCHER = '1d4410af-70f5-4c14-8606-519404684ea7'

const verified = {
  signatureValid: true,
  legacyCanonical: false,
  signedFaceValue: 1000,
  cappedAtFaceValue: false,
}

/** The metadata `dmCrypto` builds, with `issuerId` off the SIGNED voucher. */
const from = (issuerId: string, overrides: Record<string, unknown> = {}) => ({
  issuerId,
  voucherId: VOUCHER,
  faceValue: 400,
  validation: verified,
  ...overrides,
})

beforeEach(() => {
  stubs.merchant = { pubkey: MY_STALL, active: true }
})

describe('a stall taking a coupon in', () => {
  it('refuses a coupon issued by a different stall', () => {
    // The finding. Genuine signature, genuine coupon, and not ours to honour.
    expect(() => refuseIfAnotherStalls(from(OTHER_STALL), MY_STALL)).toThrow(
      RedemptionRefusedError,
    )
  })

  it('accepts its own coupon coming back', () => {
    // The control. A check that refused this would stop the product working.
    expect(() => refuseIfAnotherStalls(from(MY_STALL), MY_STALL)).not.toThrow()
  })

  it('compares keys case-insensitively', () => {
    // Nothing normalises case on the way in — `issuerId` comes off the voucher
    // and `currentPubkey` off the session — so a case difference would refuse a
    // stall's own coupon. That failure would look exactly like the fraud this
    // check exists to stop, which is the worst way to get it wrong.
    expect(() =>
      refuseIfAnotherStalls(from(MY_STALL.toUpperCase()), MY_STALL.toLowerCase()),
    ).not.toThrow()
  })

  it('still refuses when the stall is closed for business', () => {
    // `loadMerchant`, not `isMerchant`: a stall winding down still attests the
    // coupons it takes (see the attestation gate), so it must still refuse the
    // ones that were never its own. If the two gates disagreed about who a
    // wallet is, a closed stall could take another stall's coupon and attest it.
    stubs.merchant = { pubkey: MY_STALL, active: false }
    expect(() => refuseIfAnotherStalls(from(OTHER_STALL), MY_STALL)).toThrow(
      RedemptionRefusedError,
    )
  })

  it('names the stall and the coupon on the error', () => {
    // A refusal a merchant cannot explain to the customer in front of them is
    // barely better than a silent failure.
    try {
      refuseIfAnotherStalls(from(OTHER_STALL), MY_STALL)
      expect.fail('should have refused')
    } catch (error) {
      const refusal = error as RedemptionRefusedError
      expect(refusal.voucherId).toBe(VOUCHER)
      expect(refusal.message).toContain(OTHER_STALL.slice(0, 16))
      // Not a ceiling breach. Reporting a number here would have the UI say
      // the coupon was spent, which is a different and untrue story.
      expect(refusal.alreadyRedeemed).toBe(0)
    }
  })
})

describe('who this check does not speak for', () => {
  it('says nothing in a customer wallet', () => {
    // THE case that must not break. Every coupon a customer holds is another
    // party's claim; refusing them would empty the product of its purpose.
    stubs.merchant = null
    expect(() => refuseIfAnotherStalls(from(OTHER_STALL), 'some-customer-key')).not.toThrow()
  })

  it('says nothing about plain ecash', () => {
    // No voucher, so no issuer claim to check. `validation` is absent exactly
    // as it is for a non-voucher token.
    expect(() =>
      refuseIfAnotherStalls({ voucherId: VOUCHER, faceValue: 400 }, MY_STALL),
    ).not.toThrow()
  })

  it('says nothing when the signature did not verify', () => {
    // `dmCrypto` already refused the message. Double-handling it here would
    // report the wrong reason for the same rejection.
    expect(() =>
      refuseIfAnotherStalls(
        from(OTHER_STALL, { validation: { ...verified, signatureValid: false } }),
        MY_STALL,
      ),
    ).not.toThrow()
  })

  it('says nothing when the coupon names no issuer', () => {
    // Nothing to compare against. Refusing on an absent field would reject
    // legacy rows that predate the voucher carrying an issuer at all.
    expect(() => refuseIfAnotherStalls(from(''), MY_STALL)).not.toThrow()
  })

  it('says nothing when the session has no key yet', () => {
    // The poller can be mid-start. Fail open here: `refuseIfOverRedeemed` and
    // the mint still stand behind this, and refusing every coupon during a
    // start-up window would be a far worse failure than the one it prevents.
    expect(() => refuseIfAnotherStalls(from(OTHER_STALL), undefined)).not.toThrow()
  })

  it('says nothing about a LICENCE, which always comes from another issuer', () => {
    // The exception that keeps stalls in business. A licence (ADR 0007) is a
    // voucher delivered by the same DM path, issued by US and sent TO the
    // stall, so its `issuerId` is never the receiving stall's own key.
    //
    // Without the exception this check would refuse every subscription a
    // merchant bought — an outage strictly worse than the bug it closes,
    // because a stall could no longer renew. Caught while reviewing the first
    // implementation, which had exactly that defect.
    const { token, voucher } = buildVoucherToken({
      merchantMetadata: JSON.stringify({ subscription_id: 'sub_9f2c11', features: ['terminals'] }),
      faceValue: 4000,
      unit: 'GBP',
    })
    // The licence issuer is not this stall — that is the whole point.
    expect(voucher.issuerId.toLowerCase()).not.toBe(MY_STALL)

    expect(() =>
      refuseIfAnotherStalls(from(voucher.issuerId), MY_STALL, token),
    ).not.toThrow()
  })

  it('still refuses another stall’s ORDINARY coupon when a token is supplied', () => {
    // The control for the licence exception: passing a token must not become a
    // way to bypass the check. Same call shape, ordinary voucher, still refused.
    const { token, voucher } = buildVoucherToken({ faceValue: 4000, unit: 'GBP' })
    expect(() => refuseIfAnotherStalls(from(voucher.issuerId), MY_STALL, token)).toThrow(
      RedemptionRefusedError,
    )
  })
})
