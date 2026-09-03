/**
 * The wallet's money decisions, with nothing browser-shaped in them.
 *
 * Which coupons satisfy an amount, how a coupon splits, what the minimum split
 * step is, what obstacle blocks a plan. These answers have to be identical
 * whether a customer taps Send in the app or a program calls the API — the
 * whole point of the package is that the two cannot drift apart about what a
 * spend costs.
 *
 * Nothing here reads storage, the network or the gateway. Everything is a
 * function of the coupons it is handed, which is what lets it run in plain Node
 * with no DOM shim.
 *
 * Extracted from the app's `src/lib/pay.ts`, where these sat alongside the send
 * saga and could only be reached from a browser. The reasoning in the comments
 * comes with them: most of it records a decision someone had to make twice.
 */

import type { Voucher } from '@imani/voucher-send'



/**
 * Milliseconds since the epoch, from whatever shape an expiry arrived in.
 *
 * Copied from the app's `format.ts` rather than imported, because that module
 * is full of `Intl` formatting this package has no business owning — taking it
 * whole would drag currency display into a package about spend decisions.
 *
 * The leniency is not decoration. `expires_at` is typed `string` and is stored
 * as a NUMBER by the redemption path, in seconds or milliseconds depending on
 * who wrote it, so a parser that trusted the type would read every numeric
 * expiry as invalid and sort every coupon as "never expires".
 */
export function toEpochMs(value: number | string | undefined | null): number | undefined {
  if (value === undefined || value === null || value === '' || value === 0) return undefined

  const ms =
    typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * The smallest face amount a coupon can be divided into.
 *
 * A cashu proof is indivisible below one sat, and one sat is worth
 * `issuance_ratio` face minor units — so nothing smaller than `ceil(ratio)` can
 * be split off. imani-apps computes the same floor to step its amount input
 * (`voucher/js/send.js:2319-2325`); here the amount arrives fixed in a payment
 * request, so it is a validation rather than an input constraint.
 *
 * At this stack's ratio of 1.0 with 2-decimal EUR this is one cent, so it never
 * bites today. It becomes real the moment a merchant issues at a ratio above 1 —
 * a 5000 XAF coupon backed by 200 sats has a floor of 25 XAF.
 */
export function minSplitStep(voucher: Voucher): number {
  const face = voucher.face_value ?? 0
  const sats = voucher.token_amount ?? 0
  const ratio = voucher.issuance_ratio ?? (sats > 0 ? face / sats : 0)
  return Math.max(1, Math.ceil(ratio))
}

export type SplitCheck = { ok: true } | { ok: false; reason: string }

/**
 * Can this coupon pay exactly this amount?
 *
 * A full send needs no split and is always allowed — that is the path a 1-sat
 * coupon still has. Anything else has to leave at least one whole sat on BOTH
 * sides: the merchant cannot be sent a fraction of a proof, and neither can the
 * change. imani-apps enforces the send side by stepping its input and the keep
 * side by capping it at `floor(max / step)`; both are checked explicitly here.
 */
export function checkSplittable(voucher: Voucher, amount: number): SplitCheck {
  const face = voucher.face_value ?? 0
  const sats = voucher.token_amount ?? 0

  if (amount <= 0) return { ok: false, reason: 'The amount must be more than zero.' }
  if (amount > face) return { ok: false, reason: 'This voucher is worth less than the amount.' }
  if (amount === face) return { ok: true } // full send — no split involved

  // Below here a split is required.
  if (sats <= 0) {
    return { ok: false, reason: 'This voucher has no sats backing, so it cannot be split.' }
  }
  if (sats <= 1) {
    return {
      ok: false,
      reason: 'This voucher is backed by a single sat and can only be spent whole.',
    }
  }

  const step = minSplitStep(voucher)
  if (amount < step) {
    return { ok: false, reason: `The smallest amount this voucher can be split into is ${step}.` }
  }
  if (face - amount < step) {
    return {
      ok: false,
      reason: `Paying this would leave less than ${step} behind, which cannot be split off.`,
    }
  }
  return { ok: true }
}

/**
 * Still has value to send?
 *
 * `'spent'` is voucher-send's own vocabulary; `'redeemed'` is a merchant's
 * coupon that came home and was burnt (burn.ts). Offering either would build a
 * send the mint refuses, after the confirmation screen has already promised it.
 */
function isUnspent(voucher: Voucher): boolean {
  const status = (voucher.status ?? '').toLowerCase()
  return status !== 'spent' && status !== 'redeemed'
}

/**
 * Coupons that could pay this amount, best first.
 *
 * Soonest-expiring leads, which is the same rule `planParts` follows and for
 * the same reason: the coupon closest to being lost is the one worth spending.
 * This did NOT order by expiry, and the single-coupon path is the one that
 * carries most payments — so a coupon expiring next week sat untouched while
 * one expiring next year was spent, purely because it was smaller. The bundle
 * path had the rule and this one did not, which meant the wallet's answer to
 * "which coupon goes first" depended on whether one coupon happened to cover
 * the amount.
 *
 * Within an expiry, exact matches lead — they need no split at all — then the
 * smallest coupons that can be divided to it, which keeps the larger coupons
 * whole for larger payments. Ties break on voucher id so the same wallet plans
 * the same way twice.
 *
 * Returns every candidate rather than one, because the gateway can refuse a
 * specific coupon (see payRequest).
 */
export function selectVouchers(vouchers: Voucher[], amount: number): Voucher[] {
  return vouchers
    .filter((v) => v.token && isUnspent(v) && checkSplittable(v, amount).ok)
    .sort((a, b) => {
      const byExpiry = expiryMs(a) - expiryMs(b)
      if (byExpiry !== 0) return byExpiry
      // An exact match needs no split, so it beats anything else at the same
      // expiry — including a smaller coupon that would have to be divided.
      const exactA = a.face_value === amount ? 0 : 1
      const exactB = b.face_value === amount ? 0 : 1
      if (exactA !== exactB) return exactA - exactB
      const byFace = (a.face_value ?? 0) - (b.face_value ?? 0)
      if (byFace !== 0) return byFace
      return String(a.voucher_id ?? '').localeCompare(String(b.voucher_id ?? ''))
    })
}

/** One draw against one coupon. Several of them make a bundle. */
export type SendPart = { voucher: Voucher; amount: number }

/**
 * How an amount is drawn across several coupons — a bundle, when one won't do.
 *
 * `remaining` is what could not be planned; zero means the plan covers the
 * amount. Reported rather than thrown so `splitObstacle` can say what is in the
 * way without running the walk twice.
 */
export type SendPlan = { parts: SendPart[]; remaining: number }

/**
 * Plan a draw across coupons, soonest-expiring first.
 *
 * Ported from imani-apps' `_buildPlan` + `_sortByExpiryFirst`
 * (shared/bundleSendOrchestrator.js:748), with its ordering rules intact:
 * expiry first, so the coupon closest to being lost is the one spent; then
 * largest face, which keeps the part count — and so the number of mint splits
 * and NIP-17 DMs — as low as it can go; then voucher id, so the same wallet
 * plans the same way twice.
 *
 * What upstream's planner does NOT do is check that a draw is possible. Taking
 * `min(face, remaining)` from each coupon in turn is right about arithmetic and
 * silent about the mint: a coupon cannot be divided below one sat's worth of
 * face value, so a part that leaves dust behind is a split the gateway refuses
 * halfway through a bundle — after earlier parts have already been delivered
 * and cannot be taken back. Greedy full draws make that easy to contain: every
 * part but the last takes a whole coupon, so only the last is ever a partial
 * draw, and only it needs `checkSplittable`. A coupon that cannot supply the
 * residue is skipped and the next one tried.
 */
export function planParts(vouchers: Voucher[], amount: number): SendPlan {
  const usable = vouchers
    .filter((v) => v.token && isUnspent(v) && (v.face_value ?? 0) > 0)
    .sort((a, b) => {
      const byExpiry = expiryMs(a) - expiryMs(b)
      if (byExpiry !== 0) return byExpiry
      const byFace = (b.face_value ?? 0) - (a.face_value ?? 0)
      if (byFace !== 0) return byFace
      return String(a.voucher_id ?? '').localeCompare(String(b.voucher_id ?? ''))
    })

  const parts: SendPart[] = []
  let remaining = amount
  for (const voucher of usable) {
    if (remaining <= 0) break
    const face = voucher.face_value ?? 0
    if (face <= remaining) {
      parts.push({ voucher, amount: face })
      remaining -= face
    } else if (checkSplittable(voucher, remaining).ok) {
      parts.push({ voucher, amount: remaining })
      remaining = 0
    }
  }
  return { parts, remaining }
}

/**
 * Sortable expiry. No expiry sorts last — it is the coupon in least danger.
 *
 * Through `toEpochMs`, NOT `Date.parse`, because `expires_at` is not reliably
 * an ISO string however the type declares it. `Voucher.expires_at` says
 * `string`, and `dmPoll`'s storage adapter casts a NUMBER into it
 * (`v.expires_at as number | undefined`), which is the shape the redemption
 * path actually stores; `issue.ts` records the same, that it "has been seen as
 * both an ISO-8601 string and a number, and the number itself could be seconds
 * or milliseconds".
 *
 * `Date.parse(1788220800)` is NaN, so every numerically-stored expiry fell to
 * the MAX_SAFE_INTEGER branch and sorted as "never expires" — putting the
 * coupon in most danger LAST, the exact opposite of this function's purpose.
 * It was invisible while this only broke ties inside `planParts`; making expiry
 * the primary key on both send paths is what turned it into the money bug it
 * always looked like.
 *
 * `toEpochMs` is the wallet's one answer to this question — it takes ISO,
 * seconds or milliseconds, and applies the same 1e11 magnitude test used for
 * every other timestamp here.
 */
function expiryMs(voucher: Voucher): number {
  return toEpochMs(voucher.expires_at as number | string | undefined) ?? Number.MAX_SAFE_INTEGER
}

/**
 * Why this amount cannot be sent, for the amount screen.
 *
 * Asked in the same order the send itself asks: one coupon if one will do, a
 * bundle otherwise. Holding enough is not the same as being able to send it —
 * what stops a send now is not "no coupon is big enough" but "the last piece
 * cannot be broken off anything", so the message reports against the residue
 * the plan could not draw, and against the largest coupon it did not already
 * spend on the earlier parts.
 *
 * Returns null when the total is simply short: the screen says that better,
 * with the figure.
 *
 * Both send doors bundle, so there is no "can this caller draw several?" to ask.
 * There briefly was: while `payRequest` spent exactly one coupon, silence here
 * put its Pay button live on an amount it would then refuse. The fix was to
 * teach that door to bundle (see `deliver`), not to keep two answers.
 */
export function splitObstacle(vouchers: Voucher[], amount: number): string | null {
  if (selectVouchers(vouchers, amount).length > 0) return null

  // Several coupons cover it between them, which both doors can now draw.
  const plan = planParts(vouchers, amount)
  if (plan.remaining === 0) return null

  const spent = new Set(plan.parts.map((p) => p.voucher))
  const best = vouchers
    .filter((v) => v.token && isUnspent(v) && !spent.has(v))
    .sort((a, b) => (b.face_value ?? 0) - (a.face_value ?? 0))[0]
  if (!best) return null

  const check = checkSplittable(best, plan.remaining)
  return check.ok ? null : check.reason
}

/** States where the backend holds the token and expects the sender to take it back. */
const RECLAIMABLE = ['DM_ERROR', 'RECLAIM_READY', 'EXPIRED', 'FAILED', 'SPLIT_ERROR']

/** Poll budget for the send saga: 40 × 500ms = 20s before we stop waiting. */
