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

import { readExpiry } from './expiry'

// The one expiry parser lives in ./expiry (#157). Re-exported from here
// because callers have long imported `toEpochMs` from the spend module.
export { toEpochMs } from './expiry'

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

/**
 * What a coupon can really be sent for, in face minor units (#638).
 *
 * The row's `face_value` is a claim. The gateway's split (`VoucherSplitCalculator.previewSplit`,
 * gateway-core v0.42.0) values the token at `CouponRate.shownFaceOf(sats)`, its sats' worth rounded
 * HALF UP, and refuses a draw above that ("Insufficient balance: requested 1, available 0"). Any
 * request up to that value goes through: a PROPORTIONAL part that needs more sats than are left is
 * sent as the whole token. So a coupon is worth the smaller of its stored face (a row already
 * restated down stays down) and `halfUp(sats x ratio)`. Not floor: 10 sats at 0.0579... are 0.58,
 * which the gateway sends as 1, and valuing them at 0 would hide that penny.
 *
 * The motivating row: face 1, 8 sats of a 407-face / 7020-sat GBP coupon. 8 x 0.05797... = 0.46,
 * worth 0. Planned at its stored 1, it led every bundle (it expired first) and the gateway aborted
 * each one.
 *
 * On the ratio as written, in exact decimals (`BigDecimal.valueOf(ratio)`), as the gateway does for
 * a coupon whose minted sats it cannot prove. The proven path (`sats x face / mintedSats`) needs the
 * signed face, which a row does not carry. The two differ only a hair from a half unit, and the
 * whole coupon is its signed face either way. Without sats or a ratio there is nothing to check
 * against and the stored face stands (legacy rows).
 */
export function couponValue(voucher: Voucher): number {
  const face = voucher.face_value ?? 0
  const sats = voucher.token_amount ?? 0
  const ratio = voucher.issuance_ratio
  if (!(face > 0)) return 0
  if (!Number.isSafeInteger(sats) || !(sats > 0)) return face
  if (typeof ratio !== 'number' || !(ratio > 0) || !Number.isFinite(ratio)) return face
  const shown = halfUpTimes(sats, ratio)
  if (shown === null) return face
  // Other strategies send `floor(amount / ratio)` sats and refuse more than the token holds, so the
  // most they can draw is the largest amount under (sats + 1) x ratio (10 sats at 0.0579... under
  // FULL: 0.637, so 0, though it shows as 1). A row with no strategy keeps the PROPORTIONAL reading.
  const strategy = String(voucher.backing_strategy ?? '').toUpperCase()
  if (strategy !== '' && strategy !== 'PROPORTIONAL') {
    const reach = Math.ceil((sats + 1) * ratio) - 1
    return Math.max(0, Math.min(face, shown, reach))
  }
  return Math.min(face, shown)
}

/** `BigDecimal.valueOf(sats).multiply(BigDecimal.valueOf(ratio)).setScale(0, HALF_UP)`. */
function halfUpTimes(sats: number, ratio: number): number | null {
  const [mantissa, exp = '0'] = String(ratio).toLowerCase().split('e')
  const [whole, frac = ''] = mantissa.split('.')
  const scale = frac.length - Number(exp)
  const digits = BigInt(whole + frac)
  const n = BigInt(sats) * (scale < 0 ? digits * 10n ** BigInt(-scale) : digits)
  const d = scale > 0 ? 10n ** BigInt(scale) : 1n
  const q = n / d
  const v = 2n * (n % d) >= d ? q + 1n : q
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v)
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
  // What the token can be credited for, not the row's claim (#638).
  const face = couponValue(voucher)
  const sats = voucher.token_amount ?? 0

  if (amount <= 0) return { ok: false, reason: 'The amount must be more than zero.' }
  if (amount > face) return { ok: false, reason: 'This voucher is worth less than the amount.' }
  if (amount === face) return { ok: true } // full send — no split involved

  // Below here a split is required.
  if (sats <= 0) {
    return {
      ok: false,
      reason: 'This voucher has no sats backing, so it cannot be split.',
    }
  }
  if (sats <= 1) {
    return {
      ok: false,
      reason: 'This voucher is backed by a single sat and can only be spent whole.',
    }
  }

  const step = minSplitStep(voucher)
  if (amount < step) {
    return {
      ok: false,
      reason: `The smallest amount this voucher can be split into is ${step}.`,
    }
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
      const exactA = couponValue(a) === amount ? 0 : 1
      const exactB = couponValue(b) === amount ? 0 : 1
      if (exactA !== exactB) return exactA - exactB
      const byFace = couponValue(a) - couponValue(b)
      if (byFace !== 0) return byFace
      return String(a.voucher_id ?? '').localeCompare(String(b.voucher_id ?? ''))
    })
}

/**
 * How a send or payment draws `amount`: the one rule every door uses (owner report 2026-11-17).
 *
 * Soonest-expiring first, always. One coupon is still preferred (fewer splits, one DM), but only
 * when no usable coupon expires sooner than it. Otherwise the bundle plan, which starts at the
 * soonest coupon: €2 expiring tomorrow and €10 expiring next year, paying €5, spends the €2 and
 * €3 of the €10, rather than €5 of the €10 while the €2 lapses.
 *
 * `single` keeps every candidate, in `selectVouchers` order, so the payer can walk to the next
 * when the gateway refuses one.
 * `bundle` may have `remaining > 0`: nothing covers the amount. Callers pass only comparable
 * coupons (one issuer, one unit), as they already did for `selectVouchers` and `planParts`.
 */
export type SpendChoice = { kind: 'single'; candidates: Voucher[] } | { kind: 'bundle'; plan: SendPlan }

export function chooseSpend(vouchers: Voucher[], amount: number): SpendChoice {
  const single = selectVouchers(vouchers, amount)
  if (single.length === 0) return { kind: 'bundle', plan: planParts(vouchers, amount) }
  const plan = planParts(vouchers, amount)
  // The bundle wins only when it covers the amount AND draws on a coupon that expires sooner than
  // the best single one. A sooner coupon that cannot take part (it cannot be divided to the
  // residue) leaves one coupon as the answer.
  const sooner = plan.parts.some((p) => expiryMs(p.voucher) < expiryMs(single[0]))
  if (plan.remaining > 0 || !sooner || plan.parts.length < 2) return { kind: 'single', candidates: single }
  return { kind: 'bundle', plan }
}

/**
 * The most coupons one payment may draw when the gateway does not advertise its own cap
 * (`gateway.atomic-send.bundle.max-parts`, served as `atomic_send_bundle_max_parts`, #552).
 */
export const DEFAULT_BUNDLE_MAX_PARTS = 10

/**
 * A bundle plan brought under the part cap, the one way both doors do it (#552).
 *
 * Soonest-expiring first can need many parts: twelve €1 coupons expiring next week beside a €50
 * one, paying €12, is twelve parts, over a cap of 10. Planned again with the largest coupons first
 * (`largestFirst`, fewest parts) it is one. The largest-first plan replaces the expiry plan only
 * when it still covers the amount and has fewer parts, and only once the expiry plan is over the
 * cap: under the cap, expiry order is the rule.
 *
 * May still be over the cap. That is the caller's to refuse, before anything is spent, with
 * `tooManyPartsMessage`.
 */
export function withinPartCap(vouchers: Voucher[], amount: number, plan: SendPlan, maxParts: number): SendPlan {
  if (plan.parts.length <= maxParts) return plan
  const fewer = planParts(vouchers, amount, { largestFirst: true })
  return fewer.remaining === 0 && fewer.parts.length < plan.parts.length ? fewer : plan
}

/** The refusal for a plan over the cap. Said before anything is spent. */
export function tooManyPartsMessage(parts: number, max: number): string {
  return (
    `This amount needs ${parts} vouchers, and one payment can use at most ${max}. ` +
    'Nothing was sent. Send a smaller amount, or send the rest as a second payment.'
  )
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
export function planParts(
  vouchers: Voucher[],
  amount: number,
  /**
   * #552: `largestFirst` drops the expiry ordering and draws the largest coupons first, which
   * gives the fewest parts. Used when the expiry-first plan has more parts than the gateway
   * accepts in one atomic bundle.
   */
  options: { largestFirst?: boolean } = {},
): SendPlan {
  const usable = vouchers
    // A coupon worth 0 to the gateway is never a part (#638): the gateway aborts the whole bundle.
    .filter((v) => v.token && isUnspent(v) && couponValue(v) > 0)
    .sort((a, b) => {
      const byExpiry = options.largestFirst ? 0 : expiryMs(a) - expiryMs(b)
      if (byExpiry !== 0) return byExpiry
      const byFace = couponValue(b) - couponValue(a)
      if (byFace !== 0) return byFace
      return String(a.voucher_id ?? '').localeCompare(String(b.voucher_id ?? ''))
    })

  const parts: SendPart[] = []
  let remaining = amount
  for (const voucher of usable) {
    if (remaining <= 0) break
    const face = couponValue(voucher)
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
 * `readExpiry` (./expiry) is the wallet's one answer to this question: it takes
 * ISO, seconds or milliseconds, and tells the last two apart at 1e12, so a
 * far-future expiry in seconds is never mistaken for a 1970s one.
 */
function expiryMs(voucher: Voucher): number {
  const expiry = readExpiry(voucher.expires_at)
  if (expiry.kind === 'at') return expiry.seconds * 1000
  // Genuinely absent: the coupon in least danger, last.
  if (expiry.kind === 'none') return Number.MAX_SAFE_INTEGER
  // Corrupt, the last fallback (#157). Storage canonicalises every readable
  // format to epoch seconds, so only a value no parser can read gets here. It
  // might lapse tomorrow, so it goes FIRST: spending it early can only use
  // value that was at risk, while sorting it as "never expires" could strand it
  // past a real expiry nobody could read. If the gateway refuses it as expired,
  // the payer walks on to the next candidate (`initiateOnFirstFree`).
  return Number.MIN_SAFE_INTEGER
}

/** Why a coupon that expires sooner than the one spent was not used. */
export type PassedOverReason = 'issuer' | 'unit' | 'split' | 'small'

export type PassedOver = {
  voucher: Voucher
  reason: PassedOverReason
  /** For 'split', checkSplittable's own sentence. */
  detail?: string
}

/**
 * The issuer id the way `VoucherGrouper` derives it: a missing id is the
 * 'unknown' stall, a 64-char hex key is lower-cased, and anything else (an
 * npub, which is case-sensitive bech32) is kept as it is.
 *
 * Lives here so the app's grouping (`merchants.ts`) and `passedOver` compare
 * issuers with one rule (#169 review). A bare toLowerCase folded npubs and
 * matched an empty payee id to every issuer-less coupon.
 */
export function issuerKey(issuerId: string | undefined | null): string {
  const id = issuerId || 'unknown'
  if (id.startsWith('npub1')) return id
  return /^[0-9a-f]{64}$/i.test(id) ? id.toLowerCase() : id
}

const sameIssuer = (a: string | undefined, b: string) => issuerKey(a) === issuerKey(b)
const sameUnit = (a: string | undefined, b: string) => (a ?? '').toUpperCase() === b.toUpperCase()

/**
 * Coupons that expire sooner than what this payment will spend, and why each
 * was left (#157).
 *
 * The spend rule is "soonest-expiring first, within what the payee accepts".
 * When a sooner coupon is outside that (another issuer, another unit) or cannot
 * be divided to the amount, leaving it is correct, but from the outside it
 * looks exactly like the wallet ignoring its own rule. This names them so the
 * pay screen and the `[pay]` log can say so.
 *
 * `vouchers` is the WHOLE holding, not the payee's coupons: the reasons only
 * exist relative to what was filtered out. Returns [] when nothing can pay,
 * because the obstacle message already speaks for that case.
 */
export function passedOver(
  vouchers: Voucher[],
  amount: number,
  payee: { issuer: string; unit: string },
): PassedOver[] {
  const live = vouchers.filter((v) => v.token && isUnspent(v) && couponValue(v) > 0)
  const eligible = live.filter(
    (v) => sameIssuer(v.issuer_id, payee.issuer) && sameUnit(v.face_unit, payee.unit),
  )

  const choice = chooseSpend(eligible, amount)
  let spent: Voucher[]
  if (choice.kind === 'single') spent = [choice.candidates[0]]
  else {
    if (choice.plan.remaining > 0) return []
    spent = choice.plan.parts.map((p) => p.voucher)
  }
  const latestSpent = Math.max(...spent.map(expiryMs))
  const used = new Set(spent)

  return live
    .filter((v) => !used.has(v) && expiryMs(v) < latestSpent)
    .sort((a, b) => expiryMs(a) - expiryMs(b))
    .map((voucher): PassedOver => {
      if (!sameIssuer(voucher.issuer_id, payee.issuer)) return { voucher, reason: 'issuer' }
      if (!sameUnit(voucher.face_unit, payee.unit)) return { voucher, reason: 'unit' }
      // Worth less than the amount: it could only pay as part of a bundle, and
      // one coupon that covers the amount is preferred over drawing several.
      // Not "cannot be divided", which would be untrue of it.
      if (couponValue(voucher) < amount) return { voucher, reason: 'small' }
      const check = checkSplittable(voucher, amount)
      return {
        voucher,
        reason: 'split',
        detail: check.ok ? undefined : check.reason,
      }
    })
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
    .filter((v) => v.token && isUnspent(v) && !spent.has(v) && couponValue(v) > 0)
    .sort((a, b) => couponValue(b) - couponValue(a))[0]
  if (!best) return null

  const check = checkSplittable(best, plan.remaining)
  return check.ok ? null : check.reason
}

/** Poll budget for the send saga: 40 × 500ms = 20s before we stop waiting. */
