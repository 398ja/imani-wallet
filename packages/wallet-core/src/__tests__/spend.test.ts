/**
 * The money decisions, tested where they now live.
 *
 * Moved from the app's `src/lib/__tests__/pay.test.ts` unchanged in substance,
 * with the code they cover. The app's file keeps the tests for the send saga —
 * the parts that touch storage, the gateway and the legacy bridge — which is
 * the same line the extraction drew.
 *
 * No mocks, and none needed: everything under test is a function of the
 * coupons it is handed.
 */

import { describe, it, expect } from 'vitest'
import type { Voucher } from '@imani/voucher-send'

import {
  checkSplittable,
  minSplitStep,
  planParts,
  selectVouchers,
  splitObstacle,
} from '../index'

/** A €5.00 coupon, the only denomination this stack issues. */
const coupon = (over: Partial<Voucher> = {}): Voucher =>
  ({
    voucher_id: 'v-1',
    token: 'cashuBv2xyz',
    face_value: 500,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 500,
    issuer_id: 'f'.repeat(64),
    status: 'active',
    ...over,
  }) as Voucher

/**
 * A 5000 XAF coupon backed by 200 sats — issuance ratio 25.
 *
 * The EUR coupons this stack issues sit at ratio 1.0, where the minimum split
 * step is one cent and no realistic amount can hit the floor. At ratio 25 the
 * floor is 25 XAF and the guard becomes reachable, which is the only way to
 * test it.
 */
const xaf = (over: Partial<Voucher> = {}): Voucher =>
  ({
    voucher_id: 'v-xaf',
    token: 'cashuBv2xaf',
    face_value: 5000,
    face_unit: 'XAF',
    face_decimals: 0,
    token_amount: 200,
    issuance_ratio: 25,
    issuer_id: 'f'.repeat(64),
    status: 'active',
    ...over,
  }) as Voucher

describe('minSplitStep', () => {
  it('is one sat expressed in face minor units, rounded up', () => {
    expect(minSplitStep(xaf())).toBe(25)
    // Ratio 0.5 would allow half a minor unit per sat; money has no half cent,
    // so the floor never drops below 1.
    expect(minSplitStep(xaf({ issuance_ratio: 0.5 }))).toBe(1)
    expect(minSplitStep(coupon())).toBe(1)
  })

  it('derives the ratio when it was never stored', () => {
    expect(minSplitStep(xaf({ issuance_ratio: undefined }))).toBe(25)
  })
})

describe('checkSplittable', () => {
  it('allows a full send regardless of divisibility', () => {
    // No split happens, so the floor is irrelevant — this is the only way a
    // 1-sat coupon can ever be spent.
    expect(checkSplittable(xaf(), 5000).ok).toBe(true)
    expect(checkSplittable(xaf({ token_amount: 1, issuance_ratio: 5000 }), 5000).ok).toBe(true)
  })

  it('refuses an amount smaller than one sat is worth', () => {
    const check = checkSplittable(xaf(), 10)
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('25')
  })

  it('allows an amount on the floor', () => {
    expect(checkSplittable(xaf(), 25).ok).toBe(true)
  })

  it('refuses a split that would leave un-splittable dust behind', () => {
    // 4990 of 5000 leaves 10 XAF — less than one sat's worth, so the change
    // could not be issued.
    const check = checkSplittable(xaf(), 4990)
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('behind')
  })

  it('refuses to split a voucher backed by a single sat', () => {
    const check = checkSplittable(xaf({ token_amount: 1 }), 25)
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toContain('single sat')
  })

  it('refuses a voucher with no backing at all', () => {
    expect(checkSplittable(xaf({ token_amount: 0 }), 25).ok).toBe(false)
  })

  it('refuses an amount the voucher cannot cover, or a nonsense one', () => {
    expect(checkSplittable(xaf(), 6000).ok).toBe(false)
    expect(checkSplittable(xaf(), 0).ok).toBe(false)
    expect(checkSplittable(xaf(), -25).ok).toBe(false)
  })

  it('does not bite at ratio 1, which is what this stack issues', () => {
    // Guards against over-tightening: a €0.01 payment from a €5.00 coupon is
    // legitimate and must stay allowed.
    expect(checkSplittable(coupon(), 1).ok).toBe(true)
    expect(checkSplittable(coupon(), 250).ok).toBe(true)
  })
})

describe('selectVouchers and splitObstacle', () => {
  it('offers only vouchers that can actually produce the amount', () => {
    const divisible = xaf()
    const indivisible = xaf({ voucher_id: 'v-1sat', token_amount: 1 })

    const chosen = selectVouchers([indivisible, divisible], 25)

    expect(chosen).toHaveLength(1)
    expect(chosen[0].voucher_id).toBe('v-xaf')
  })

  it('puts an exact match first, since it needs no split', () => {
    const exact = xaf({ voucher_id: 'v-exact', face_value: 25, token_amount: 1 })
    const chosen = selectVouchers([xaf(), exact], 25)
    expect(chosen[0].voucher_id).toBe('v-exact')
  })

  /**
   * The single-coupon path carries most payments, and it did not order by
   * expiry — only `planParts`, the bundle path, did. So a coupon expiring next
   * week sat untouched while one expiring next year was spent, purely because
   * it was smaller, and the wallet's answer to "which coupon goes first"
   * depended on whether one coupon happened to cover the amount.
   */
  it('spends the soonest-expiring coupon first, as the bundle path does', () => {
    const soon = xaf({
      voucher_id: 'v-soon',
      face_value: 5000,
      expires_at: '2026-09-01T00:00:00Z',
    })
    const later = xaf({
      voucher_id: 'v-later',
      face_value: 2500,
      expires_at: '2027-09-01T00:00:00Z',
    })

    // `later` is the smaller coupon, which is what the old size-only sort chose.
    expect(selectVouchers([later, soon], 1000)[0].voucher_id).toBe('v-soon')
    // Input order must not decide it either.
    expect(selectVouchers([soon, later], 1000)[0].voucher_id).toBe('v-soon')
  })

  /** A coupon that never expires is the one in least danger, so it goes last. */
  it('prefers an expiring coupon over one with no expiry at all', () => {
    const expiring = xaf({ voucher_id: 'v-expiring', expires_at: '2026-09-01T00:00:00Z' })
    const forever = xaf({ voucher_id: 'v-forever', face_value: 2500 })

    expect(selectVouchers([forever, expiring], 1000)[0].voucher_id).toBe('v-expiring')
  })

  /**
   * Expiry outranks the exact-match rule: a split is a mint round trip, losing
   * a coupon is losing money. Same expiry, and the exact match leads again.
   */
  it('takes the sooner coupon even when a later one is an exact match', () => {
    const soonSplit = xaf({
      voucher_id: 'v-soon',
      face_value: 5000,
      expires_at: '2026-09-01T00:00:00Z',
    })
    const laterExact = xaf({
      voucher_id: 'v-later-exact',
      face_value: 1000,
      expires_at: '2027-09-01T00:00:00Z',
    })
    expect(selectVouchers([laterExact, soonSplit], 1000)[0].voucher_id).toBe('v-soon')

    const sameDayExact = xaf({
      voucher_id: 'v-same-exact',
      face_value: 1000,
      expires_at: '2026-09-01T00:00:00Z',
    })
    expect(selectVouchers([soonSplit, sameDayExact], 1000)[0].voucher_id).toBe('v-same-exact')
  })

  /** Two coupons alike but for their ids must not swap order between runs. */
  it('is deterministic when expiry and face are equal', () => {
    const a = xaf({ voucher_id: 'v-aaa', expires_at: '2026-09-01T00:00:00Z' })
    const b = xaf({ voucher_id: 'v-bbb', expires_at: '2026-09-01T00:00:00Z' })

    expect(selectVouchers([b, a], 1000).map((v) => v.voucher_id)).toEqual(['v-aaa', 'v-bbb'])
    expect(selectVouchers([a, b], 1000).map((v) => v.voucher_id)).toEqual(['v-aaa', 'v-bbb'])
  })

  /**
   * `expires_at` is typed `string` and is not reliably one. dmPoll's storage
   * adapter casts a NUMBER into it, which is the shape the redemption path
   * stores, and `Date.parse(1788220800)` is NaN — so every numerically-stored
   * expiry read as "never expires" and the coupon in most danger sorted LAST.
   *
   * Harmless while expiry only broke ties inside planParts. Making it the
   * primary key on both send paths is what would have turned a latent type lie
   * into spending the wrong coupon.
   */
  it('reads a numeric expiry, not only an ISO string', () => {
    const seconds = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000)
    const soon = xaf({ voucher_id: 'v-soon-epoch', expires_at: seconds as unknown as string })
    const later = xaf({ voucher_id: 'v-later', face_value: 2500, expires_at: '2027-09-01T00:00:00Z' })

    expect(selectVouchers([later, soon], 1000)[0].voucher_id).toBe('v-soon-epoch')

    // Milliseconds too — the same field has been seen in both magnitudes.
    const millis = xaf({
      voucher_id: 'v-soon-millis',
      expires_at: (seconds * 1000) as unknown as string,
    })
    expect(selectVouchers([later, millis], 1000)[0].voucher_id).toBe('v-soon-millis')
  })

  it('explains the obstacle when nothing qualifies, and stays silent when one does', () => {
    expect(splitObstacle([xaf()], 10)).toContain('25')
    expect(splitObstacle([xaf()], 25)).toBeNull()
    expect(splitObstacle([], 25)).toBeNull()
  })

  it('stays silent when no single coupon covers the amount but a bundle does', () => {
    // Two €3 coupons against €5: no single one covers it, and both doors can
    // now draw across several, so there is no obstacle to report. Reporting one
    // here is what put "no voucher for that amount" in front of a customer
    // holding twice it.
    const half = () => xaf({ face_value: 300, token_amount: 300, issuance_ratio: 1 })

    expect(splitObstacle([half(), half()], 500)).toBeNull()
  })

  it('never offers a spent or redeemed coupon', () => {
    // A redeemed coupon's proofs were burnt at the mint (burn.ts), so a send
    // built on one fails there. Offering it puts the failure in the customer's
    // face at the till instead of keeping it off the list.
    // `VoucherStatus` in the vendored voucher-send package predates the burn, so
    // 'redeemed' is cast in — the same widening `toVoucher` does, since the
    // store's own status is a plain string.
    const dead = [
      { ...xaf({ voucher_id: 'v-redeemed' }), status: 'redeemed' } as unknown as Voucher,
      xaf({ status: 'spent' }),
    ]

    expect(selectVouchers(dead, 25)).toEqual([])
    // ...and it is not counted as a candidate the split merely failed to fit.
    expect(splitObstacle(dead, 25)).toBeNull()
  })
})

describe('planParts', () => {
  const at = (days: number) => new Date(Date.now() + days * 864e5).toISOString()

  it('spends the coupon closest to expiring first', () => {
    // The ordering rule ported from `_sortByExpiryFirst`, and the only one that
    // is about the customer rather than the mint: a coupon that expires on
    // Friday is worth nothing on Saturday, so it goes first even when a coupon
    // with no expiry would cover the amount on its own.
    const soon = coupon({ voucher_id: 'v-soon', face_value: 300, expires_at: at(2) })
    const later = coupon({ voucher_id: 'v-later', face_value: 900, expires_at: at(60) })

    const plan = planParts([later, soon], 300)

    expect(plan.remaining).toBe(0)
    expect(plan.parts).toHaveLength(1)
    expect(plan.parts[0].voucher.voucher_id).toBe('v-soon')
  })

  /**
   * The two paths must not disagree about which coupon goes first. They did:
   * `selectVouchers` sorted by size alone, so which coupon the wallet reached
   * for depended on whether one happened to cover the amount — the same three
   * coupons, a different first pick, for no reason a customer could see.
   */
  it('agrees with selectVouchers about which coupon leads', () => {
    const soon = coupon({ voucher_id: 'v-soon', face_value: 500, expires_at: at(2) })
    const later = coupon({ voucher_id: 'v-later', face_value: 300, expires_at: at(60) })
    const forever = coupon({ voucher_id: 'v-forever', face_value: 400 })
    const all = [forever, later, soon]

    // One coupon covers 200, so the single path answers.
    expect(selectVouchers(all, 200)[0].voucher_id).toBe('v-soon')
    // Nothing covers 1000 alone, so the bundle path answers — same coupon first.
    expect(planParts(all, 1000).parts[0].voucher.voucher_id).toBe('v-soon')
  })

  it('draws across several coupons when no single one covers the amount', () => {
    const a = coupon({ voucher_id: 'v-a' })
    const b = coupon({ voucher_id: 'v-b' })
    const c = coupon({ voucher_id: 'v-c' })

    const plan = planParts([a, b, c], 1200)

    expect(plan.remaining).toBe(0)
    // Whole coupons first and one partial draw last, which is what keeps the
    // splittable check to a single part.
    expect(plan.parts.map((p) => p.amount)).toEqual([500, 500, 200])
  })

  it('reports what it could not draw when the coupons do not add up', () => {
    const plan = planParts([coupon()], 800)

    expect(plan.remaining).toBe(300)
    expect(plan.parts.map((p) => p.amount)).toEqual([500])
  })

  it('skips a coupon that cannot be split down to the residue', () => {
    // Upstream's `_buildPlan` takes `min(face, remaining)` with no splittable
    // check, and would hand the gateway a split it refuses — halfway through a
    // bundle, after earlier parts have already been delivered and cannot be
    // recalled. At ratio 25 nothing below 25 XAF can come off the coupon.
    const whole = xaf({ voucher_id: 'v-whole', face_value: 100, token_amount: 100, issuance_ratio: 1 })
    const coarse = xaf({ voucher_id: 'v-coarse', face_value: 50, token_amount: 2 })

    const plan = planParts([whole, coarse], 110)

    expect(plan.remaining).toBe(10)
    expect(plan.parts.map((p) => p.voucher.voucher_id)).toEqual(['v-whole'])
  })
})
