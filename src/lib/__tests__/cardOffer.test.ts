/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { reconcileCardOffer } from '../cardOffer'
import { emptyMerchant, type MerchantProfile } from '../merchant'

/**
 * Keeping "I take cards" honest.
 *
 * The flag is self-asserted, which is safe only because it is checked for real
 * when money moves. These tests are about the other half of that bargain: the
 * assertion tracking reality closely enough that a shopper rarely meets a
 * button that cannot work.
 */
const stall = (over: Partial<MerchantProfile> = {}): MerchantProfile => ({
  ...emptyMerchant('b'.repeat(64)),
  issuanceCurrency: 'GBP',
  ...over,
})

describe('reconciling a stall’s card offer', () => {
  it('starts offering when Stripe can charge', () => {
    const change = reconcileCardOffer(stall(), {
      chargesEnabled: true,
      defaultCurrency: 'gbp',
    }, 'included')

    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') {
      expect(change.merchant.acceptsCards).toBe(true)
    }
  })

  it('withdraws the offer when Stripe stops accepting charges', () => {
    const change = reconcileCardOffer(stall({ acceptsCards: true }), {
      chargesEnabled: false,
    }, 'included')

    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') {
      expect(change.merchant.acceptsCards).toBe(false)
      expect(change.reason).toContain('not accepting charges')
    }
  })

  it('changes nothing when the status could not be read', () => {
    // Unknown is not "cards are off". Withdrawing a working stall's offer
    // because the merchant service blipped would take it out of business for
    // the duration of an outage.
    expect(reconcileCardOffer(stall({ acceptsCards: true }), null, 'included').kind).toBe('unchanged')
    expect(reconcileCardOffer(stall(), null, 'included').kind).toBe('unchanged')
  })

  it('refuses to offer cards when the currencies disagree', () => {
    // imani-woo ADR 0005: a coupon cannot split across units, so a session in
    // one currency and a coupon in another cannot both be right. Caught here,
    // while configuring, rather than at a customer's failed payment.
    //
    // A stall that was not offering and still cannot is `unchanged`: there is
    // nothing to publish, and publishing anyway would write an identical record
    // on every check.
    expect(reconcileCardOffer(stall({ issuanceCurrency: 'GBP' }), {
      chargesEnabled: true,
      defaultCurrency: 'eur',
    }, 'included').kind).toBe('unchanged')

    // A stall that WAS offering has an offer to withdraw, and the reason names
    // both currencies so the owner can see which one to change.
    const withdrawn = reconcileCardOffer(
      stall({ acceptsCards: true, issuanceCurrency: 'GBP' }),
      { chargesEnabled: true, defaultCurrency: 'eur' },
      'included',
    )

    expect(withdrawn.kind).toBe('republish')
    if (withdrawn.kind === 'republish') {
      expect(withdrawn.merchant.acceptsCards).toBe(false)
      expect(withdrawn.reason).toContain('GBP')
      expect(withdrawn.reason).toContain('EUR')
    }
  })

  it('withdraws an offer that was published before the currencies diverged', () => {
    // A stall can change issuanceCurrency on another device, and the record
    // arrives asynchronously. This is the check that catches it.
    const change = reconcileCardOffer(
      stall({ acceptsCards: true, issuanceCurrency: 'EUR' }),
      { chargesEnabled: true, defaultCurrency: 'gbp' },
      'included',
    )

    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') {
      expect(change.merchant.acceptsCards).toBe(false)
    }
  })

  it('refuses to offer cards before the account has a currency', () => {
    const change = reconcileCardOffer(stall(), { chargesEnabled: true }, 'included')

    expect(change.kind).toBe('unchanged')
  })

  it('is quiet when nothing changed', () => {
    // No republish means no relay write. A reconcile that published on every
    // check would fill a stall's history with identical records.
    expect(reconcileCardOffer(stall({ acceptsCards: true }), {
      chargesEnabled: true,
      defaultCurrency: 'gbp',
    }, 'included').kind).toBe('unchanged')

    expect(reconcileCardOffer(stall(), { chargesEnabled: false }, 'included').kind).toBe('unchanged')
  })

  it('matches currency case-insensitively', () => {
    // Stripe answers lowercase, the stall record is uppercase. A case-sensitive
    // compare would withdraw every correctly configured stall's offer.
    expect(reconcileCardOffer(stall({ acceptsCards: true, issuanceCurrency: 'gbp' }), {
      chargesEnabled: true,
      defaultCurrency: 'GBP',
    }, 'included').kind).toBe('unchanged')
  })

  it('withdraws the offer on Starter, even with Stripe ready', () => {
    // Card payments are Essentials and above. A Starter stall (or one whose plan ended) that
    // still publishes "I take cards" is told why it stopped.
    const change = reconcileCardOffer(stall({ acceptsCards: true }), { chargesEnabled: true, defaultCurrency: 'gbp' }, 'not-included')

    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') {
      expect(change.merchant.acceptsCards).toBe(false)
      expect(change.reason).toMatch(/Essentials/)
    }
  })

  it('never starts an offer on Starter', () => {
    expect(reconcileCardOffer(stall(), { chargesEnabled: true, defaultCurrency: 'gbp' }, 'not-included').kind).toBe('unchanged')
  })

  it('changes nothing for the plan when the plan could not be checked', () => {
    // Unknown neither starts an offer (the stall may be on Starter) nor withdraws one (a paying
    // stall must not go dark because the licence check failed for a moment).
    expect(reconcileCardOffer(stall(), { chargesEnabled: true, defaultCurrency: 'gbp' }, 'unknown').kind).toBe('unchanged')
    expect(reconcileCardOffer(stall({ acceptsCards: true }), { chargesEnabled: true, defaultCurrency: 'gbp' }, 'unknown').kind).toBe('unchanged')
  })

  it('still withdraws for Stripe’s reasons when the plan is unknown', () => {
    const change = reconcileCardOffer(stall({ acceptsCards: true }), { chargesEnabled: false }, 'unknown')

    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') expect(change.reason).toMatch(/Stripe/)
  })
})

describe('a stall taking cards through PayPal', () => {
  const paypal = { chargesEnabled: true, defaultCurrency: 'gbp', processor: 'paypal' as const }

  it('publishes an offer that names PayPal', () => {
    const change = reconcileCardOffer(stall(), paypal, 'included')
    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') {
      expect(change.merchant.acceptsCards).toBe(true)
      expect(change.merchant.cardProcessor).toBe('paypal')
      expect(change.reason).toMatch(/PayPal/)
    }
  })

  it('is quiet when the offer already names PayPal', () => {
    expect(reconcileCardOffer(stall({ acceptsCards: true, cardProcessor: 'paypal' }), paypal, 'included').kind).toBe('unchanged')
  })

  it('corrects an offer that still names Stripe, even with the plan unknown', () => {
    // Buyers would be sent to a Stripe checkout the stall no longer uses. Correcting which
    // processor an existing offer names is not a new offer, so an unknown plan does not hold it.
    for (const plan of ['included', 'unknown'] as const) {
      const change = reconcileCardOffer(stall({ acceptsCards: true }), paypal, plan)
      expect(change.kind, plan).toBe('republish')
      if (change.kind === 'republish') {
        expect(change.merchant.acceptsCards).toBe(true)
        expect(change.merchant.cardProcessor).toBe('paypal')
      }
    }
  })

  it('withdraws in PayPal’s words', () => {
    const change = reconcileCardOffer(stall({ acceptsCards: true, cardProcessor: 'paypal' }), { chargesEnabled: false, processor: 'paypal' }, 'included')
    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') {
      expect(change.merchant.acceptsCards).toBe(false)
      expect(change.reason).toBe('PayPal is not accepting charges for this stall yet')
    }
    const mismatch = reconcileCardOffer(stall({ acceptsCards: true, cardProcessor: 'paypal' }), { ...paypal, defaultCurrency: 'eur' }, 'included')
    if (mismatch.kind === 'republish') expect(mismatch.reason).toMatch(/PayPal account presents in EUR/)
  })

  it('withdraws on Starter as for Stripe', () => {
    const change = reconcileCardOffer(stall({ acceptsCards: true, cardProcessor: 'paypal' }), paypal, 'not-included')
    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') expect(change.reason).toMatch(/Essentials/)
  })

  it('moves a Stripe offer back to Stripe when Stripe is the one connected', () => {
    const change = reconcileCardOffer(stall({ acceptsCards: true, cardProcessor: 'paypal' }), { chargesEnabled: true, defaultCurrency: 'gbp' }, 'included')
    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') expect(change.merchant.cardProcessor).toBe('stripe')
  })
})
