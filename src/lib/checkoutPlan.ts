/**
 * Which coupons can become one checkout code, and how they divide (#402), with no network in it.
 *
 * ## The question
 *
 * A customer at a stall's online shop wants to pay `amount` with that stall's coupons. A checkout
 * code is a bundle of parts, one coupon each, every one locked to the shop key `S` until the same
 * `x` (contract §2). Before anything is burnt or locked, the wallet has to know three things: which
 * coupons may take part, which may not and why (so the screen can say so), and how the amount is
 * drawn across the ones that may.
 *
 * ## Why each exclusion
 *
 * - `wrong_stall`: a code is honoured by one stall. Another stall's coupon in it is money the shop
 *   can neither take nor give back.
 * - `wrong_unit`: amounts are summed, and a sum across currencies is the bug `planSpend` warns of.
 * - `in_flight`: the coupon is the source of a send whose outcome is not known yet (#128). Locking
 *   it could spend the same money twice.
 * - `already_locked`: a coupon locked to someone (a Cashlink, an earlier code) is not ours to lock.
 * - `not_lockable`: the gateway would refuse to sign the lock (`lockableVoucher`), and finding that
 *   out after the burn strands the coupon.
 * - `expires_too_soon`: the coupon lapses too close to `x` for the gateway to lock it
 *   (`lockWindowProblem`). An `x` that is itself out of the window is an obstacle for the whole
 *   code, not an exclusion of every coupon, because a different `x` is the fix.
 *
 * ## How it divides
 *
 * Through `planParts`, the same planner a bundle send uses: soonest-expiring first, every part a
 * whole coupon except at most one split. A part's amount is the coupon's credited face value
 * (`creditableFaceValue`), which is what the store checks each part against. Among plans with the
 * same number of parts, one with a splittable coupon is preferred, so the shop can hand back change
 * later. A code carries at most 20 parts.
 */
import type { Voucher } from '@imani/voucher-send'
import type { VoucherRow } from '@imani/wallet-storage'
import { checkSplittable, minSplitStep, planParts, stallKey } from '@imani/wallet-core'

import { isSelfLocked, latestLockX, lockableVoucher, lockWindowProblem, type WindowProblem } from './cashlinkLock'
import { toVoucher } from './merchants'
import { withoutInFlight } from './pay'
import { canCarve } from './checkoutCarve'
import { canSplit } from './voucherSplitPlan'
import { creditableFaceValue, parseVoucherToken, tokenProofs, voucherOfSecret } from './voucherToken'

/** Contract §3: 1 ≤ parts ≤ 20. */
export const MAX_CHECKOUT_PARTS = 20

export type CheckoutExclusion = 'wrong_stall' | 'wrong_unit' | 'in_flight' | 'already_locked' | 'not_lockable' | 'expires_too_soon'

export interface CheckoutCandidate {
  row: VoucherRow
  /** The row as the planner reads it, with `face_value` set to the credited face value. */
  voucher: Voucher
  /** Credited face value, minor units. */
  faceValue: number
  /** The coupon's signed expiry, epoch seconds, or undefined for none. */
  expiresAt: number | undefined
  /** Whether it could be split later, for change. */
  splittable: boolean
}

export interface CheckoutPart extends CheckoutCandidate {
  /** What this part draws, minor units. Equal to `faceValue` except on the one split part. */
  amount: number
  /**
   * #402: no subset of this coupon's proofs makes `amount`, so one of its proofs must first be split
   * (gateway-customer `/vouchers/bearer-split`, `voucherSplit.ts`). Only ever on the one split part.
   */
  needsSplit?: boolean
}

export type CheckoutObstacle =
  | { kind: 'expiry_window'; problem: WindowProblem }
  | { kind: 'insufficient_value'; available: number }
  | { kind: 'not_splittable'; available: number; minimumStep?: number }
  | { kind: 'too_many_parts'; parts: number }

export interface CheckoutPlan {
  usable: CheckoutCandidate[]
  excluded: Array<{ row: VoucherRow; reason: CheckoutExclusion }>
  /** Present only when the amount can be met. */
  plan?: CheckoutPart[]
  obstacle?: CheckoutObstacle
}

export interface CheckoutPlanRequest {
  rows: VoucherRow[]
  /** The signed-in key, whose in-flight sends hold their coupons back. */
  payer: string
  /** The stall (issuer) the code is for. */
  stallId: string
  /** The currency, as the coupons carry it. */
  unit: string
  /** Minor units. */
  amount: number
  /** The code's expiry, every part's locktime, epoch seconds. */
  x: number
  nowS: number
}

function isSplittable(v: Voucher): boolean {
  const step = minSplitStep(v)
  return (v.face_value ?? 0) > step && checkSplittable(v, step).ok
}

/** One row as a candidate, or the reason it cannot be one. `payer` is the wallet's own key. */
function candidateOf(row: VoucherRow, x: number, nowS: number, payer: string): CheckoutCandidate | CheckoutExclusion {
  const status = (row.status ?? '').toLowerCase()
  if (status === 'spent' || status === 'redeemed') return 'not_lockable'
  let proofs: ReturnType<typeof tokenProofs>
  let faceValue: number
  try {
    proofs = tokenProofs(row.token)
    faceValue = creditableFaceValue(parseVoucherToken(row.token)).faceValue
  } catch {
    return 'not_lockable'
  }
  if (proofs.length === 0 || faceValue <= 0) return 'not_lockable'
  let expiresAt: number | undefined
  for (const proof of proofs) {
    // #402: locked to this wallet's own key alone (a split voucher's part) is ours to lock.
    if (voucherOfSecret(proof.secret)?.lockKey && !isSelfLocked(proof.secret, payer)) return 'already_locked'
    const found = lockableVoucher(proof.secret, payer)
    if ('problem' in found) return 'not_lockable'
    expiresAt = found.voucher.expiresAt
    if (lockWindowProblem(x, expiresAt, nowS)) return 'expires_too_soon'
  }
  const voucher = { ...toVoucher(row), face_value: faceValue }
  return { row, voucher, faceValue, expiresAt, splittable: isSplittable(voucher) }
}

/** `planParts` over candidates, mapped back to them. Null when the amount is not met. */
function draw(candidates: CheckoutCandidate[], amount: number): CheckoutPart[] | null {
  const byVoucher = new Map(candidates.map((c) => [c.voucher, c]))
  const result = planParts(
    candidates.map((c) => c.voucher),
    amount,
  )
  if (result.remaining !== 0) return null
  return result.parts.map((p) => ({ ...byVoucher.get(p.voucher)!, amount: p.amount }))
}

/**
 * A part is carved from its coupon's own proofs, offline (`checkoutCarve.ts`): only whole proofs
 * move. A plan whose split part no subset of proofs can make would be refused AFTER Get code
 * (staging 2026-10-31: 'this amount cannot be taken from that coupon'), so it is not a plan.
 */
const carvable = (plan: CheckoutPart[]) => plan.every((p) => p.amount === p.faceValue || canCarve(p.row.token, p.amount))

/**
 * A plan every part of which can be carved: `draw`'s own, or the same draw with the uncarvable
 * split coupon left out (the next coupon is then split instead). Null when none can.
 */
function drawCarvable(candidates: CheckoutCandidate[], amount: number): CheckoutPart[] | null {
  const first = draw(candidates, amount)
  if (!first || carvable(first)) return first
  let pool = candidates
  for (let tries = 0; tries < candidates.length; tries++) {
    const plan = draw(pool, amount)
    if (!plan) return null
    if (carvable(plan)) return plan
    const stuck = plan.find((p) => p.amount !== p.faceValue && !canCarve(p.row.token, p.amount))
    if (!stuck) return null
    pool = pool.filter((c) => c.row !== stuck.row)
  }
  return null
}

/**
 * #402: `draw`'s plan when its one uncarvable part can be split (`canSplit`), that part marked
 * `needsSplit`. Null when the draw fails, or more than one part is stuck, or the stuck one cannot be
 * split either.
 */
function drawSplittable(candidates: CheckoutCandidate[], amount: number): CheckoutPart[] | null {
  const plan = draw(candidates, amount)
  if (!plan) return null
  const stuck = plan.filter((p) => p.amount !== p.faceValue && !canCarve(p.row.token, p.amount))
  if (stuck.length !== 1 || !canSplit(stuck[0].row.token, stuck[0].amount)) return null
  return plan.map((p) => (p === stuck[0] ? { ...p, needsSplit: true } : p))
}

/**
 * The same number of parts, but with a splittable coupon in it, when `planParts`'s own answer has
 * none: leave out one unsplittable part at a time and plan again.
 */
function preferSplittable(candidates: CheckoutCandidate[], amount: number, plan: CheckoutPart[]): CheckoutPart[] {
  if (plan.some((p) => p.splittable)) return plan
  for (const part of plan) {
    const other = drawCarvable(
      candidates.filter((c) => c.row !== part.row),
      amount,
    )
    if (other && other.length === plan.length && other.some((p) => p.splittable)) return other
  }
  return plan
}

/** Which coupons can make this code, which cannot and why, and how the amount divides. */
export function checkoutPlan(req: CheckoutPlanRequest): CheckoutPlan {
  const excluded: CheckoutPlan['excluded'] = []
  const usable: CheckoutCandidate[] = []
  const stall = stallKey(req.stallId)
  const unit = req.unit.trim().toUpperCase()
  const free = new Set(withoutInFlight(req.rows, req.payer))

  for (const row of req.rows) {
    if (stallKey(row.issuer_id) !== stall) {
      excluded.push({ row, reason: 'wrong_stall' })
      continue
    }
    if ((row.face_unit ?? '').trim().toUpperCase() !== unit) {
      excluded.push({ row, reason: 'wrong_unit' })
      continue
    }
    if (!free.has(row)) {
      excluded.push({ row, reason: 'in_flight' })
      continue
    }
    const found = candidateOf(row, req.x, req.nowS, req.payer)
    if (typeof found === 'string') excluded.push({ row, reason: found })
    else usable.push(found)
  }

  // The x itself, before any coupon is blamed for it.
  const xProblem = lockWindowProblem(req.x, undefined, req.nowS)
  if (xProblem) return { usable, excluded, obstacle: { kind: 'expiry_window', problem: xProblem } }

  const available = usable.reduce((sum, c) => sum + c.faceValue, 0)
  if (!Number.isSafeInteger(req.amount) || req.amount <= 0 || available < req.amount) {
    return { usable, excluded, obstacle: { kind: 'insufficient_value', available } }
  }
  const plan = drawCarvable(usable, req.amount)
  if (!plan) {
    // #402: the amount can be drawn, only not carved whole. When the one stuck coupon can be split
    // into denominations that make its share, offer it: the split runs on Get code.
    const split = drawSplittable(usable, req.amount)
    if (split && split.length <= MAX_CHECKOUT_PARTS) return { usable, excluded, plan: split }
    const steps = usable.map((c) => minSplitStep(c.voucher))
    return { usable, excluded, obstacle: { kind: 'not_splittable', available, minimumStep: steps.length ? Math.min(...steps) : undefined } }
  }
  if (plan.length > MAX_CHECKOUT_PARTS) return { usable, excluded, obstacle: { kind: 'too_many_parts', parts: plan.length } }
  return { usable, excluded, plan: preferSplittable(usable, req.amount, plan) }
}

/**
 * The latest code expiry every one of these coupons can be locked until, or null when there is
 * none (one of them lapses too soon for any `x`). The screen offers expiries up to this.
 */
export function maxExpiryFor(parts: ReadonlyArray<{ expiresAt: number | undefined }>, nowS: number): number | null {
  let latest: number | null = latestLockX(undefined, nowS)
  for (const part of parts) {
    const x = latestLockX(part.expiresAt, nowS)
    if (x === null || latest === null) return null
    latest = Math.min(latest, x)
  }
  return latest
}
