/**
 * Keeping a stall's published "I take cards" in step with whether it does.
 *
 * `acceptsCards` lives on the stall's own kind-30078 record because it is the
 * only channel a stranger has: every `imani-merchant` endpoint is self-scoped,
 * so nobody can ask about somebody else's `charges_enabled`. The cost of that
 * is a flag the stall asserts about itself, and the job of this module is to
 * make sure the assertion stays true without the stall having to think about it.
 *
 * ## Republishing is the whole mechanism
 *
 * A kind-30078 is parameterised-replaceable: publishing a new one replaces the
 * old wholesale. So "withdraw the offer" is not a delete, it is a republish
 * without the field, and `mergeMerchantEvent` reads an absent field as false
 * precisely so that this works.
 *
 * ## Wired, as of Settings → Payments
 *
 * This block used to say the opposite: that nothing called this, so the flag
 * was never published, so no Buy button ever rendered and the whole
 * card-purchase path was dark. The screen it said was missing now exists —
 * `PaymentsSettingsPage` — and every path through it ends here: connect,
 * refresh, disconnect, and the plain status read on mount.
 *
 * That last one is the quiet one worth knowing about. A stall whose Stripe was
 * disabled while they were away has its offer withdrawn the next time they open
 * the screen, without doing anything, because the mount path reconciles too.
 *
 * ## Why this refuses to publish a claim it cannot support
 *
 * The flag is checked for real when a session is created: `payment-adapter`
 * knows the true `chargesEnabled` and refuses a purchase regardless of what the
 * relay says. So a wrong flag costs a shopper one failed tap. That is cheap,
 * and it is not free, which is why this only ever publishes what the gateway
 * has just told us rather than what we hope is true.
 */

import { CARD_PAYMENTS_NOT_IN_PLAN_REASON, type CardPaymentsPlan } from './cardPaymentsAccess'
import { processorName, processorOf, type CardProcessor } from './cardProcessor'
import type { MerchantProfile } from './merchant'

/**
 * What the merchant service says about the stall's card account, at Stripe or at PayPal.
 *
 * `processor` is which one answered, Stripe when absent. A stall takes cards through one processor
 * at a time, so the offer it publishes names that processor (`cardProcessor`) and a buyer is sent
 * to its checkout (payment-adapter ADR 0002).
 */
export interface StripeStatus {
  /** Whether the processor will actually accept a charge today. */
  chargesEnabled: boolean
  /** The account's presentment currency, if it has one yet. */
  defaultCurrency?: string
  processor?: CardProcessor
}

export type CardOfferChange =
  /** Publish this record; the offer changed. */
  | { kind: 'republish'; merchant: MerchantProfile; reason: string }
  /** Nothing to do. */
  | { kind: 'unchanged' }

/**
 * What, if anything, to publish after learning a stall's Stripe status.
 *
 * Returns a decision rather than performing one, so the caller owns the signing
 * and the network, and so this can be reasoned about without either.
 *
 * `plan` is whether the stall's plan includes card payments (Essentials and
 * above, never Starter). `not-included` withdraws an offer whatever Stripe
 * says. `unknown` (the licence could not be checked) never starts an offer and
 * never withdraws one on the plan's account: a stall that may be on Starter
 * must not begin offering cards, and a paying stall must not lose its offer
 * because the check failed for a moment.
 */
export function reconcileCardOffer(
  merchant: MerchantProfile,
  status: StripeStatus | null,
  plan: CardPaymentsPlan,
): CardOfferChange {
  // Null means we could not ask. NOT the same as "cards are off": withdrawing
  // a working stall's offer because the merchant service was briefly down
  // would take a stall out of business over a blip. Unknown changes nothing,
  // exactly as an unreachable gateway does when confirming issuance.
  if (status === null) {
    return { kind: 'unchanged' }
  }

  const processor: CardProcessor = status.processor ?? 'stripe'
  const name = processorName(processor)
  const stripeAllows = status.chargesEnabled && currencyIsUsable(merchant, status)
  const alreadyOffers = merchant.acceptsCards === true
  // An offer naming the other processor sends buyers to a checkout this stall no longer uses.
  const sameProcessor = processorOf(merchant) === processor
  const named = (acceptsCards: boolean): MerchantProfile => ({ ...merchant, acceptsCards, cardProcessor: processor })

  // Ready but the plan is unknown: leave the offer as it is, except to correct which processor it
  // names (that is not a new offer, and a stale one fails every purchase).
  if (stripeAllows && plan === 'unknown') {
    return alreadyOffers && !sameProcessor
      ? { kind: 'republish', merchant: named(true), reason: `${name} can accept charges for this stall` }
      : { kind: 'unchanged' }
  }

  const shouldOffer = stripeAllows && plan === 'included'

  if (shouldOffer === alreadyOffers && (sameProcessor || !shouldOffer)) {
    return { kind: 'unchanged' }
  }

  if (!shouldOffer && stripeAllows) {
    return {
      kind: 'republish',
      merchant: named(false),
      reason: CARD_PAYMENTS_NOT_IN_PLAN_REASON,
    }
  }

  return {
    kind: 'republish',
    merchant: named(shouldOffer),
    reason: shouldOffer
      ? `${name} can accept charges for this stall`
      : reasonForWithdrawing(merchant, status, name),
  }
}

/**
 * Whether the coupon's currency and the account's agree.
 *
 * `imani-woo` ADR 0005: a coupon cannot split across units, so a session priced
 * in one currency and a coupon issued in another cannot both be right. Refused
 * at setup rather than at checkout, which means the stall learns while
 * configuring rather than through a customer's failed payment — and the way a
 * stall "learns" here is by not being offered as a card seller at all.
 */
function currencyIsUsable(merchant: MerchantProfile, status: StripeStatus): boolean {
  if (!status.defaultCurrency) return false
  return status.defaultCurrency.toLowerCase() === merchant.issuanceCurrency.toLowerCase()
}

/** Something a stall owner can act on, rather than "it stopped working". */
function reasonForWithdrawing(merchant: MerchantProfile, status: StripeStatus, name: string): string {
  if (!status.chargesEnabled) {
    return `${name} is not accepting charges for this stall yet`
  }
  if (!status.defaultCurrency) {
    return `this stall’s ${name} account has no currency yet`
  }
  return `this stall issues in ${merchant.issuanceCurrency} but its ${name} account presents in ${status.defaultCurrency.toUpperCase()}`
}
