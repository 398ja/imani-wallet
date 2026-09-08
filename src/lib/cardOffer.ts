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
 * ## NOT YET CALLED, and the feature is dark until it is
 *
 * Nothing in the app invokes this, so `acceptsCards` is never published, so
 * `MerchantPage` never renders a Buy button and no purchase can begin. Stated
 * here rather than left to be discovered, because every other piece of the
 * card-purchase path is built and a reader could reasonably assume this one is
 * wired too.
 *
 * What it needs is a stall-facing Stripe screen in Settings: connect, read the
 * status back, and call this with the answer. That screen does not exist — the
 * wallet has no Stripe UI at all — and building it is the remaining step
 * between a working backend and a working feature.
 *
 * ## Why this refuses to publish a claim it cannot support
 *
 * The flag is checked for real when a session is created: `payment-adapter`
 * knows the true `chargesEnabled` and refuses a purchase regardless of what the
 * relay says. So a wrong flag costs a shopper one failed tap. That is cheap,
 * and it is not free, which is why this only ever publishes what the gateway
 * has just told us rather than what we hope is true.
 */

import type { MerchantProfile } from './merchant'

/** What the merchant service says about a stall's Stripe account. */
export interface StripeStatus {
  /** Whether Stripe will actually accept a charge today. */
  chargesEnabled: boolean
  /** The account's presentment currency, if it has one yet. */
  defaultCurrency?: string
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
 */
export function reconcileCardOffer(
  merchant: MerchantProfile,
  status: StripeStatus | null,
): CardOfferChange {
  // Null means we could not ask. NOT the same as "cards are off": withdrawing
  // a working stall's offer because the merchant service was briefly down
  // would take a stall out of business over a blip. Unknown changes nothing,
  // exactly as an unreachable gateway does when confirming issuance.
  if (status === null) {
    return { kind: 'unchanged' }
  }

  const shouldOffer = status.chargesEnabled && currencyIsUsable(merchant, status)
  const alreadyOffers = merchant.acceptsCards === true

  if (shouldOffer === alreadyOffers) {
    return { kind: 'unchanged' }
  }

  return {
    kind: 'republish',
    merchant: { ...merchant, acceptsCards: shouldOffer },
    reason: shouldOffer
      ? 'Stripe can accept charges for this stall'
      : reasonForWithdrawing(merchant, status),
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
function reasonForWithdrawing(merchant: MerchantProfile, status: StripeStatus): string {
  if (!status.chargesEnabled) {
    return 'Stripe is not accepting charges for this stall yet'
  }
  if (!status.defaultCurrency) {
    return 'this stall’s Stripe account has no currency yet'
  }
  return `this stall issues in ${merchant.issuanceCurrency} but its Stripe account presents in ${status.defaultCurrency.toUpperCase()}`
}
