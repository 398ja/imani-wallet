import type { SignedVoucherFields } from './voucherToken'

/**
 * The seller's side of a subscription: what a licence voucher must carry.
 *
 * This is the half of ticket 05 that is worth testing. Minting is an HTTP call
 * and delivery is a DM, both of which `issue.ts` and `seed-merchant.mjs` already
 * do; what is NEW here is the metadata, and the metadata is the entire licence.
 * `verifyLicence` reads its lock key, its expiry and its grant from these bytes,
 * and `licences.ts` decides from them whether the thing is money or a
 * subscription — so a field written wrongly here is a licence that grants
 * nothing, or worse, a subscription that lands in a merchant's balance.
 *
 * Selling is deliberately out-of-band (the spec: "building one before knowing
 * what people ask is guessing"). So there is no purchase flow and no screen.
 * There is this module, which says what a licence IS, and a script that mints
 * one — and the split exists so the part with rules can be tested without a
 * gateway, a mint, or a relay.
 *
 * ## The reader is the specification
 *
 * Every field name here is one `src/lib/licences.ts` reads back out:
 * `subscription_id`, `features`, `pilot`, `lock_key`. They are not free choices
 * and must not drift — a rename on this side is a licence the wallet stops
 * recognising, which reads to the customer as a subscription that silently
 * became money. The round-trip test in `__tests__/licenceIssue.test.ts` mints
 * through this module and reads back through that one for exactly that reason;
 * asserting the JSON shape here alone would pass while the pair disagreed.
 */

/** Feature names a licence can confer. One feature today, by design. */
export const LICENCE_FEATURES = {
  /** Enrol and run terminals beyond the free one. The spec's whole subject. */
  TERMINALS: 'terminals',
} as const

export type LicenceFeature = (typeof LICENCE_FEATURES)[keyof typeof LICENCE_FEATURES]

/**
 * The term of a subscription.
 *
 * Annual by default: "renewal is a DELIVERY — minting a replacement voucher and
 * getting it to the device — so a monthly plan is twelve chances a year for a
 * relay to lose a paying customer's access. Annual makes that risk annual."
 * Monthly exists for stalls that cannot commit.
 */
export const LICENCE_TERMS = {
  ANNUAL: 'annual',
  MONTHLY: 'monthly',
} as const

export type LicenceTerm = (typeof LICENCE_TERMS)[keyof typeof LICENCE_TERMS]

/**
 * Days in a term.
 *
 * Days rather than calendar months, because the gateway's issuance API takes
 * `expiry_days` and nothing else — so a "calendar" term would be converted to
 * days somewhere regardless, and doing it here keeps the one conversion visible
 * instead of hidden in a caller.
 *
 * 365 and 30. Not 365.25, not a month that varies: a subscription that expires
 * on a predictable day is easier to support than one that is astronomically
 * correct, and the customer is told the date either way.
 */
export const TERM_DAYS: Record<LicenceTerm, number> = {
  [LICENCE_TERMS.ANNUAL]: 365,
  [LICENCE_TERMS.MONTHLY]: 30,
}

/**
 * A stable id for a customer relationship, in the voucher's own metadata.
 *
 * NOT a customer key and not a `voucher_id`. The spec is explicit about why
 * neither works: "a renewal is a new voucher with a new `voucher_id`, and a
 * re-issue after key loss is a new `K`, so neither identifies a customer over
 * time." This is the thread support follows, and it is carried in the
 * credential rather than stored by us — which is what keeps it from becoming
 * the account database every decision here has avoided.
 *
 * Random rather than derived from anything about the customer. A subscription
 * id derived from a key or a name would leak that into a credential the
 * customer hands to their own devices, and would change when the thing it was
 * derived from did — which is the one property it must not have.
 */
export function newSubscriptionId(
  randomHex: () => string = defaultRandomHex,
): string {
  return `sub_${randomHex()}`
}

function defaultRandomHex(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What the seller decides when selling one subscription. */
export interface LicenceTerms {
  /**
   * The customer's key, which the licence is locked to.
   *
   * The licence is only usable by whoever holds this key: `verifyLicence`
   * refuses a voucher whose lock key is not the presenter's, and refuses one
   * carrying no lock at all. So this is not decoration — a licence minted
   * without it grants nothing, which is why it is a required field rather than
   * an optional one.
   */
  lockKey: string
  /**
   * Carried over on a renewal and on a re-issue to a new key. A fresh one
   * starts a new relationship, so a caller that omits it when it meant to renew
   * has quietly created a second customer.
   */
  subscriptionId: string
  features?: readonly LicenceFeature[]
  /**
   * A pilot holds a real voucher, marked — never a build-time bypass, because
   * "a bypass makes the paid path the untested one". The marker is what
   * separates support and revenue from guesswork.
   */
  pilot?: boolean
  /** What the customer actually paid, in minor units of `paidCurrency`. */
  paidAmountMinor: number
  /**
   * The currency actually paid in, which may not be the quoted one: the price
   * is quoted in fiat and settled "either way", in fiat or in sats, and the
   * voucher records what was paid.
   */
  paidCurrency: string
}

/**
 * The `merchant_metadata` JSON for a licence.
 *
 * A string, because that is what the voucher tag holds and what the wallet
 * parses back — `merchant_metadata` is one NUT-10 tag value, not a nested
 * object, and the issuer's signature covers exactly these bytes.
 *
 * Keys are snake_case, matching every other wire shape this app reads and, more
 * importantly, matching `LicenceMetadata` in `licences.ts` exactly.
 */
export function licenceMetadataJson(terms: LicenceTerms): string {
  const features = terms.features ?? [LICENCE_FEATURES.TERMINALS]

  if (!terms.lockKey) {
    // Refused here rather than minted and refused later. A licence with no lock
    // is one `verifyLicence` will never grant, so minting it would sell a
    // customer a credential that cannot work — and they would discover that
    // instead of us.
    throw new Error('a licence must be locked to the customer key')
  }
  if (!terms.subscriptionId) {
    throw new Error('a licence must carry a subscription id')
  }
  if (features.length === 0) {
    // `licences.ts` needs both an id AND a feature to recognise a licence at
    // all, so an empty grant is not a weak licence, it is an invisible one: the
    // wallet would treat it as an ordinary coupon and offer it for spending.
    throw new Error('a licence must confer at least one feature')
  }

  return JSON.stringify({
    subscription_id: terms.subscriptionId,
    features: [...features],
    lock_key: terms.lockKey,
    // Written only when true. `licences.ts` reads `pilot === true`, so a
    // `false` would be noise in bytes the issuer signs, and every paying
    // customer's voucher would carry a field about pilots.
    ...(terms.pilot ? { pilot: true } : {}),
    paid_amount_minor: terms.paidAmountMinor,
    paid_currency: terms.paidCurrency,
  })
}

/** What the seller sends to the issuance API for one licence. */
export interface LicenceIssueParams {
  faceValueMinor: number
  currency: string
  expiryDays: number
  memo: string
  merchantMetadata: string
}

/**
 * One sale, as an issuance request.
 *
 * **The face value is the price paid**, which is the spec's decision and worth
 * restating because it looks like a bug: "it costs nothing, and it makes the
 * credential its own receipt". The hazard it creates — a wallet summing a
 * licence into a balance — is closed on the wallet side by `spendable`, not by
 * pretending the voucher is worth zero. A zero-value licence would be a
 * credential that answers "what did I pay?" with "nothing".
 *
 * The memo is human text a support conversation can read back, and it is the
 * one field a customer sees without tooling.
 */
export function licenceIssueParams(
  terms: LicenceTerms,
  term: LicenceTerm = LICENCE_TERMS.ANNUAL,
): LicenceIssueParams {
  return {
    faceValueMinor: terms.paidAmountMinor,
    currency: terms.paidCurrency,
    expiryDays: TERM_DAYS[term],
    memo: `Imani subscription (${term})`,
    merchantMetadata: licenceMetadataJson(terms),
  }
}

/**
 * The terms for renewing an existing subscription.
 *
 * The whole of a renewal is "the same subscription id, a later expiry". Keeping
 * it as a named function rather than asking callers to spread an object is
 * deliberate: the failure it prevents — minting a renewal with a fresh id — is
 * silent, produces a working licence, and quietly turns one relationship into
 * two, which is precisely what the id exists to stop.
 *
 * The key is taken fresh rather than carried over, because a re-issue after key
 * loss is also a renewal in every respect but the key: "as a stall owner who
 * lost a key, I want a way to be re-issued, so that a lost phone is not a lost
 * year."
 */
export function renewalTerms(
  previous: Pick<LicenceTerms, 'subscriptionId' | 'features' | 'pilot'>,
  next: Omit<LicenceTerms, 'subscriptionId'>,
): LicenceTerms {
  return {
    ...next,
    subscriptionId: previous.subscriptionId,
    // Carried over so a renewal does not silently change what was bought, and
    // a re-issue to a replacement key confers what the lost one did.
    features: next.features ?? previous.features,
    pilot: next.pilot ?? previous.pilot,
  }
}

/**
 * What a licence voucher says it cost, read back off the credential.
 *
 * The receipt half of "the subscription is its own receipt". It reads the
 * metadata rather than the voucher's face value because those can disagree in
 * one direction that matters: a licence paid for in sats is quoted in fiat, and
 * the face value records the quote. What the customer actually handed over is
 * what `paid_*` holds.
 *
 * Falls back to the signed face value, so a licence minted before these fields
 * existed still answers the question rather than showing a blank.
 */
export function paidFor(
  signed: Pick<SignedVoucherFields, 'faceValue' | 'unit' | 'merchantMetadata'>,
): { amountMinor: number; currency: string } | null {
  try {
    const meta = JSON.parse(signed.merchantMetadata ?? '') as {
      paid_amount_minor?: unknown
      paid_currency?: unknown
    }
    const amount = meta.paid_amount_minor
    const currency = meta.paid_currency
    if (typeof amount === 'number' && Number.isFinite(amount) && typeof currency === 'string') {
      return { amountMinor: amount, currency }
    }
  } catch {
    // Not a licence, or one minted before the paid fields existed.
  }

  if (typeof signed.faceValue === 'number' && signed.unit) {
    return { amountMinor: signed.faceValue, currency: signed.unit }
  }
  return null
}
