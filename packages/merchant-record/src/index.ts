/**
 * The stall's public merchant record, as far as a coupon's life is concerned.
 *
 * One implementation for the wallet (`src/lib/merchant.ts`, which re-exports all of this) and the
 * purchase issuer (imani-wallet#312). The issuer used to mint every card coupon for a hard-coded
 * 365 days because it had no way to read the stall's own term; a second copy of these rules in
 * the service would be the next way for the two to disagree, denominated in a customer's coupon.
 *
 * Pure: no relay, no storage, no DOM.
 */

/** The kind and `d` tag that make an event a merchant record. */
export const MERCHANT_KIND = 30078
export const MERCHANT_D_TAG = 'imani:merchant'

/** Coupon validity options in days, from possa-merchant's `IssuanceStep.tsx`. */
export const VALIDITY_DAYS = [30, 60, 90] as const

/**
 * A coupon that never expires, as a validity.
 *
 * `null` was not available: it already means "not a validity" — the state a
 * half-typed custom term sits in — and SellPage disables its submit button on
 * exactly that. Zero is outside `MIN_VALIDITY_DAYS`, so nothing that reads a
 * day count can mistake it for one, and `issue.ts` drops `expiry_days` from the
 * request rather than sending it.
 */
export const NEVER_EXPIRES = 0

/**
 * What a stall issues when it has never said otherwise.
 *
 * Never expiring, because an expiry is a promise to a customer that the stall
 * has to keep track of, and a market stall that has not chosen a term has not
 * chosen to make that promise. A stall that wants one picks it.
 */
export const DEFAULT_VALIDITY_DAYS: number = NEVER_EXPIRES

/**
 * What a coupon's life may be set to, in whole days.
 *
 * A bound exists because the number is now typed rather than picked: `730` is
 * two years, past any market stall's horizon, and it is the difference between
 * a mistyped `3000` being caught here and a coupon dated to the next decade
 * being minted by a gateway that publishes no ceiling of its own.
 */
export const MIN_VALIDITY_DAYS = 1
export const MAX_VALIDITY_DAYS = 730

/**
 * A validity, or null for anything that is not one.
 *
 * One gate for every caller that reaches `expiry_days` eventually: what a
 * merchant types into either form, and what an event off the relay claims —
 * and that last one is publishable by anyone.
 */
export function validValidityDays(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  // Shape before value, and this order is load-bearing. `Number()` maps `false`,
  // `[]`, `' '`, `'\n'`, `'0.0'` and `'0x0'` ALL onto 0. That was harmless while
  // 0 meant nothing — every one of them failed the `>= MIN_VALIDITY_DAYS` bound
  // along with it. Now that 0 is a deliberate term, anything reaching the
  // `=== NEVER_EXPIRES` test has to be a number or a plain run of digits
  // first, or a relay event carrying `false` reads as a stall that chose
  // never-expiring.
  if (typeof value === 'string') {
    if (!/^\s*\d+\s*$/.test(value)) return null
  } else if (typeof value !== 'number') {
    return null
  }
  const days = Number(value)
  if (!Number.isInteger(days)) return null
  if (days === NEVER_EXPIRES) return NEVER_EXPIRES
  return days >= MIN_VALIDITY_DAYS && days <= MAX_VALIDITY_DAYS ? days : null
}

/**
 * The currency a merchant record says the stall issues in (`issuanceCurrency`), upper-cased, or
 * null when it names none or names something that is not a three-letter code. Null rather than the
 * wallet's display default: a caller deciding whether a sale can be issued must not guess a unit.
 */
export function currencyFromRecord(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.issuanceCurrency !== 'string') return null
    const unit = parsed.issuanceCurrency.trim().toUpperCase()
    return /^[A-Z]{3}$/.test(unit) ? unit : null
  } catch {
    return null
  }
}

/**
 * The validity a merchant record's `content` gives its coupons, read exactly as the wallet's Sell
 * screen reads it: a valid `voucherValidityDays` wins, and anything else (absent, malformed,
 * out of range, unparseable JSON) is the stall's default, `DEFAULT_VALIDITY_DAYS`.
 *
 * Kept identical to `mergeMerchantEvent` applied to `emptyMerchant` so a card coupon carries the
 * same term a coupon sold over the counter would (imani-wallet#312).
 */
export function validityFromRecord(content: string): number {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown> | null
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_VALIDITY_DAYS
    return validValidityDays(parsed.voucherValidityDays) ?? DEFAULT_VALIDITY_DAYS
  } catch {
    return DEFAULT_VALIDITY_DAYS
  }
}
