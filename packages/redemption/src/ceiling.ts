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

/**
 * Absorbs float noise in a product like `17820 * 0.0561...` (999.9999999...),
 * which must floor to 1000. Far below any real fraction of a minor unit.
 */
const EPSILON = 1e-6

/**
 * What to credit for one part of a voucher, given the parts already taken.
 *
 * **Cumulative rounding.** A part's exact value (`tokenAmount * ratio`) is
 * usually fractional. Rounding each part on its own lets the credits drift
 * from the value they stand for, by up to half a unit per part, and an
 * attacker controls the part count: 2000 one-sat proofs at ratio 0.5 are each
 * worth 0.5 and each round to 1, so 1000 of genuine value credits 2000. No
 * slack on the ceiling can tell that from an honest split, and bounding only
 * the exact sum does not help either (it is 1000 there, and every part
 * passes).
 *
 * So the credit is `floor(exactPrior + exact) - creditedPrior`, never below 0.
 * Whatever the order and however many parts, the credits taken so far always
 * sum to `floor(total exact)`, which never exceeds the genuine value, and the
 * exact ceiling in `checkCeiling` holds without any allowance. The honest
 * 9 + 9 + 17802 split at the live ratio credits 0 + 1 + 999 = 1000, the full
 * face; 2000 half-unit parts credit 1000.
 *
 * A prior with no `exact` (a row written before this existed) counts its
 * credited `amount` as exact. That can only understate what is left to credit
 * by less than a unit per such row, never overstate it.
 */
export function cumulativeCredit(exact: number, priorRedemptions: readonly PriorRedemption[]): number {
  if (!Number.isFinite(exact) || exact <= 0) return 0
  const { exactPrior, creditedPrior } = totals(priorRedemptions)
  return Math.max(0, Math.floor(exactPrior + exact + EPSILON) - creditedPrior)
}

/** Incoming priors, exact and credited. A prior with no `exact` counts its `amount`. */
function totals(priorRedemptions: readonly PriorRedemption[]) {
  let exactPrior = 0
  let creditedPrior = 0
  for (const r of priorRedemptions) {
    if (r.direction !== 'in') continue
    const amount = Number.isFinite(r.amount) ? r.amount : 0
    const e = r.exact !== undefined && Number.isFinite(r.exact) && r.exact >= 0 ? r.exact : amount
    exactPrior += e
    creditedPrior += amount
  }
  return { exactPrior, creditedPrior }
}

/**
 * The one rule for a part whose unrounded value is known: what to book, and
 * whether to take it at all. The till and wallet-api both call this.
 *
 * Two bounds, both exact, no allowance:
 *  - the CREDIT (`cumulativeCredit`) must fit under the face, so what is
 *    honoured never exceeds it;
 *  - the part's EXACT value must fit too (`exactPrior + exact <= face`), so a
 *    part arriving after the face is used up is refused and stays the
 *    sender's, rather than being swapped and honoured at 0.
 *
 * Every honest split passes both (its parts sum to the face, exactly), and
 * however an attacker splits genuine proofs the booked total is the floor of
 * their genuine value.
 */
export function checkPart(input: {
  signedFaceValue: number
  exact: number
  priorRedemptions: PriorRedemption[]
}): { credit: number; check: RedemptionCheck } {
  const { signedFaceValue, exact, priorRedemptions } = input
  const credit = cumulativeCredit(exact, priorRedemptions)
  const check = checkCeiling({ signedFaceValue, requested: credit, priorRedemptions })
  const exactFits =
    signedFaceValue <= 0 || totals(priorRedemptions).exactPrior + exact <= signedFaceValue + EPSILON
  return { credit, check: { ...check, allowed: check.allowed && exactFits } }
}
