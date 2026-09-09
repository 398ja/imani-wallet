import type { CeilingInput, PriorRedemption, RedemptionCheck } from './types.js'

/**
 * Sums what has already been taken in against a voucher, in face minor units.
 *
 * Incoming only. See `PriorRedemption.direction` for why that is the whole
 * ballgame.
 *
 * Non-finite amounts contribute zero rather than poisoning the sum to `NaN`.
 * A `NaN` total makes every comparison below false, so `allowed` would come
 * back `true` — one malformed row would silently disable the ceiling. Skipping
 * it keeps the bound enforced on every row that IS readable, which is the
 * failure direction to prefer.
 */
export function redeemedTotalOf(priorRedemptions: readonly PriorRedemption[]): number {
  return priorRedemptions
    .filter((r) => r.direction === 'in')
    .reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0)
}

/**
 * Would one more redemption fit inside what the issuer signed?
 *
 * Call BEFORE writing the row for this redemption, or exclude it from
 * `priorRedemptions` — otherwise the redemption being checked is counted
 * against itself and every second presentation of a voucher is refused.
 *
 * A pure function of its arguments: no storage, no clock, no network. That is
 * what lets a service which stores nothing enforce the same ceiling a till
 * does.
 */
export function checkCeiling(input: CeilingInput): RedemptionCheck {
  const { signedFaceValue, requested, priorRedemptions } = input

  const alreadyRedeemed = redeemedTotalOf(priorRedemptions)
  const remaining = Math.max(0, signedFaceValue - alreadyRedeemed)

  return {
    // A voucher with no signed face value has no ceiling to enforce — legacy
    // derive-only tokens store nothing there. Saying so plainly beats inventing
    // a bound and refusing honest coupons.
    allowed: signedFaceValue <= 0 || alreadyRedeemed + requested <= signedFaceValue,
    alreadyRedeemed,
    requested,
    signedFaceValue,
    remaining,
  }
}
