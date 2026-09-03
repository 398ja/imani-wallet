/**
 * Planning a spend: which coupons, split how, or why not.
 *
 * `spend.ts` holds the money decisions themselves — selection, splitting,
 * obstacles. This is the step above: narrowing a whole holding to the coupons
 * that may legally take part, then asking those decisions.
 *
 * ## Why the narrowing lives here and not in the service
 *
 * The app narrows before it plans, in three separate places: `couponsFor`
 * drops redeemed and expired coupons and filters to one stall, and `payRequest`
 * filters to one currency just before calling `deliver`. Every one of those is
 * a rule about which coupons are eligible, and the API has to apply exactly the
 * same ones or it will plan a spend the app would refuse.
 *
 * Written once here so the two cannot drift. The app's own path is unchanged —
 * it narrows from stored rows, which this package cannot see — but both now
 * answer to the same rules, and `parity.test.ts` pins that they agree.
 *
 * ## Why an obstacle rather than an error
 *
 * "Insufficient" and "cannot be split to this amount" need different actions
 * from the caller. The first is solved by waiting for more coupons; the second
 * never is, because a coupon divides only in steps and some amounts are simply
 * unreachable from a holding that is nominally large enough. A caller told only
 * "failed" retries forever.
 */

import type { Voucher } from '@imani/voucher-send'

import { planParts, selectVouchers, splitObstacle, checkSplittable, minSplitStep } from './spend'
import { stallKey } from './holding'

/** Why an amount cannot be met. */
export type ObstacleKind =
  /** The eligible coupons do not add up to the amount. More coupons would help. */
  | 'insufficient-value'
  /**
   * They add up, but no combination divides to exactly this amount. More
   * coupons of the same shape would NOT help; a different amount would.
   */
  | 'not-splittable'

export interface PlanObstacle {
  kind: ObstacleKind
  /** Human-readable, and specific enough to show a caller's own user. */
  detail: string
  /** What the eligible coupons are worth, in minor units. */
  available: number
  /** What was asked for. */
  requested: number
  /**
   * The smallest amount that can be split off the coupons in play, when that is
   * what blocks. Absent for `insufficient-value`, where it is not the issue.
   */
  minimumStep?: number
}

/** One coupon's contribution to a plan. */
export interface PlannedPart {
  couponId: string | undefined
  /** Minor units drawn from this coupon. */
  amount: number
  /** The coupon's full face value, so a caller can see whether it splits. */
  faceValue: number
  /** True when the whole coupon is spent and no split is needed. */
  whole: boolean
}

export interface SpendPlan {
  /** The parts that satisfy the amount. Empty when there is an obstacle. */
  parts: PlannedPart[]
  /** Why the amount cannot be met, or null when it can. */
  obstacle: PlanObstacle | null
  /** What the eligible coupons are worth. */
  available: number
  /** How many coupons were eligible after narrowing. */
  eligibleCount: number
}

export interface PlanRequest {
  /** Every coupon the caller holds. Narrowed here, not by the caller. */
  coupons: Voucher[]
  /** The stall being paid. */
  stallId: string
  /** The currency being spent. */
  currency: string
  /** The amount, in that currency's minor units. */
  amount: number
  /** Injected so expiry is testable at an instant. */
  now?: number
}

/**
 * The coupons that may take part in this spend.
 *
 * Four rules, and each one is a way a plan could otherwise destroy money.
 *
 * **One stall.** A coupon is a claim on exactly one stall, honoured by that
 * stall alone. Drawing another stall's coupon into a plan sends the recipient
 * something they cannot honour, redeem or return: the customer's money simply
 * stops. Nothing downstream catches it — the gateway's send takes a recipient
 * pubkey and does not care who issued what.
 *
 * **One currency.** `deliver` in the app carries the warning: adding coupons of
 * two currencies is how a request settles for a fraction of what was asked,
 * because the amounts are summed as though the units matched.
 *
 * **Still money.** A redeemed coupon's proofs are burnt, so planning against
 * one builds a spend the mint refuses.
 *
 * **Not expired.** The app filters these in `couponsFor` before planning. The
 * spend logic itself does NOT — measured: `planParts` will happily build a part
 * from a coupon that lapsed years ago — so this is the only thing standing
 * between a caller and a plan the gateway will reject.
 */
export function eligibleCoupons(
  coupons: Voucher[],
  stallId: string,
  currency: string,
  now: number,
): Voucher[] {
  const stall = stallKey(stallId)
  const unit = currency.trim().toUpperCase()

  return coupons.filter((coupon) => {
    if (!coupon.token) return false
    if (stallKey(coupon.issuer_id) !== stall) return false

    const couponUnit = (coupon.face_unit ?? '').trim().toUpperCase()
    if (couponUnit !== unit) return false

    const status = (coupon.status ?? '').toLowerCase()
    if (status === 'spent' || status === 'redeemed') return false

    if ((coupon.face_value ?? 0) <= 0) return false

    const expiry = expiryOf(coupon)
    if (expiry !== undefined && expiry <= now) return false

    return true
  })
}

/**
 * Plan a spend, or explain why it cannot be planned.
 *
 * Pure and read-only. Nothing here mutates a coupon or calls anything: planning
 * the same request twice returns the same answer and moves nothing, which is
 * what makes it safe to ask before committing.
 */
export function planSpend({
  coupons,
  stallId,
  currency,
  amount,
  now = Date.now(),
}: PlanRequest): SpendPlan {
  const eligible = eligibleCoupons(coupons, stallId, currency, now)
  const available = eligible.reduce((sum, c) => sum + (c.face_value ?? 0), 0)

  const base = { available, eligibleCount: eligible.length }

  /**
   * One coupon first, exactly as `deliver` does.
   *
   * Fewer mint splits and one DM, and `selectVouchers` already prefers an exact
   * match over splitting a larger coupon — so this is not merely an
   * optimisation, it is the rule that keeps big coupons whole for big payments.
   */
  const single = selectVouchers(eligible, amount)
  if (single.length > 0) {
    const coupon = single[0]
    const face = coupon.face_value ?? 0
    return {
      ...base,
      parts: [
        {
          couponId: coupon.voucher_id,
          amount,
          faceValue: face,
          whole: face === amount,
        },
      ],
      obstacle: null,
    }
  }

  const plan = planParts(eligible, amount)
  if (plan.remaining === 0) {
    return {
      ...base,
      parts: plan.parts.map((part) => ({
        couponId: part.voucher.voucher_id,
        amount: part.amount,
        faceValue: part.voucher.face_value ?? 0,
        whole: (part.voucher.face_value ?? 0) === part.amount,
      })),
      obstacle: null,
    }
  }

  return { ...base, parts: [], obstacle: obstacleFor(eligible, amount, available) }
}

/**
 * Which obstacle is in the way.
 *
 * The order matters and is not obvious. Simple shortfall is checked FIRST,
 * because when a holding genuinely does not add up, "cannot be split" would be
 * true as well and far less useful — the caller's action is to acquire more
 * coupons, not to pick a different amount.
 */
function obstacleFor(eligible: Voucher[], amount: number, available: number): PlanObstacle {
  if (available < amount) {
    return {
      kind: 'insufficient-value',
      detail:
        `These coupons are worth ${available}, which is less than the ${amount} requested. ` +
        'More coupons from this stall in this currency would satisfy it.',
      available,
      requested: amount,
    }
  }

  // Enough face value, so what blocks is the split. `splitObstacle` is the
  // app's own wording for this, reused rather than reworded: a caller and a
  // customer looking at the same failure should read the same sentence.
  const reason = splitObstacle(eligible, amount)

  // The smallest step across the coupons in play, so a caller learns what
  // amounts ARE reachable rather than only that this one is not.
  const steps = eligible.map(minSplitStep).filter((s) => s > 0)
  const minimumStep = steps.length > 0 ? Math.min(...steps) : undefined

  return {
    kind: 'not-splittable',
    detail:
      reason ??
      `These coupons are worth ${available}, but no combination of them divides to exactly ` +
        `${amount}. Waiting for more coupons will not help; a different amount will.`,
    available,
    requested: amount,
    minimumStep,
  }
}

/**
 * Expiry in epoch milliseconds.
 *
 * Duplicated from `spend.ts`'s private `expiryMs` rather than exported from it,
 * because that function answers "how should this SORT" and returns
 * MAX_SAFE_INTEGER for no expiry. Here the question is "has it lapsed", where
 * "no expiry" must be undefined rather than a date far in the future. Same
 * parsing, different question.
 */
function expiryOf(coupon: Voucher): number | undefined {
  const raw = coupon.expires_at as number | string | undefined
  if (raw === undefined || raw === null || raw === '' || raw === 0) return undefined
  const ms = typeof raw === 'number' ? (raw < 1e11 ? raw * 1000 : raw) : Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
}

/** Re-exported so a caller can ask whether one coupon covers an amount. */
export { checkSplittable }
