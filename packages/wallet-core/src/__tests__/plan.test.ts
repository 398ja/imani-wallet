/**
 * Planning a spend, as pure functions.
 *
 * The obstacle cases carry the weight here. A caller told only "failed" retries
 * forever; the whole point is that "you do not hold enough" and "you hold
 * enough but it cannot be divided this way" demand different actions.
 */
import { describe, expect, it } from 'vitest'

import { planSpend, eligibleCoupons } from '../plan'

const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)
const NOW = Date.parse('2026-01-01T00:00:00Z')

/**
 * A coupon. `issuance_ratio: 1` with 2 decimals means a split step of 1 minor
 * unit, so splitting is unconstrained unless a test says otherwise.
 */
const coupon = (over: Record<string, unknown> = {}) =>
  ({
    voucher_id: 'c1',
    token: 'cashuB...',
    face_value: 1000,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 1000,
    issuance_ratio: 1,
    backing_strategy: 'FULL',
    issuer_id: STALL,
    status: 'active',
    ...over,
  }) as never

const plan = (coupons: unknown[], amount: number, over: Record<string, unknown> = {}) =>
  planSpend({
    coupons: coupons as never,
    stallId: STALL,
    currency: 'EUR',
    amount,
    now: NOW,
    ...over,
  })

describe('a satisfiable amount', () => {
  it('returns the parts that satisfy it, and no obstacle', () => {
    const result = plan([coupon({ voucher_id: 'a', face_value: 1000 })], 400)

    expect(result.obstacle).toBeNull()
    expect(result.parts).toEqual([
      { couponId: 'a', amount: 400, faceValue: 1000, whole: false },
    ])
  })

  it('spends one coupon whole when it matches exactly', () => {
    const result = plan([coupon({ voucher_id: 'exact', face_value: 500 })], 500)

    expect(result.parts).toEqual([
      { couponId: 'exact', amount: 500, faceValue: 500, whole: true },
    ])
  })

  /**
   * An exact match needs no split at all, so it beats splitting a larger
   * coupon — and keeps the larger one whole for a larger payment later.
   */
  it('prefers an exact match over splitting a bigger coupon', () => {
    const result = plan(
      [
        coupon({ voucher_id: 'big', face_value: 5000 }),
        coupon({ voucher_id: 'exact', face_value: 500 }),
      ],
      500,
    )

    expect(result.parts).toHaveLength(1)
    expect(result.parts[0].couponId).toBe('exact')
    expect(result.parts[0].whole).toBe(true)
  })

  it('bundles several coupons when no single one covers the amount', () => {
    const result = plan(
      [
        coupon({ voucher_id: 'a', face_value: 500 }),
        coupon({ voucher_id: 'b', face_value: 500 }),
      ],
      800,
    )

    expect(result.obstacle).toBeNull()
    expect(result.parts.reduce((n, p) => n + p.amount, 0)).toBe(800)
    expect(result.parts).toHaveLength(2)
  })

  /**
   * The coupon closest to being lost is the one worth spending. `expires_at` is
   * read through the wallet's lenient parser, because it is stored as a number
   * as often as an ISO string.
   */
  it('spends the soonest-expiring coupon first', () => {
    const result = plan(
      [
        coupon({ voucher_id: 'later', face_value: 500, expires_at: '2027-01-01T00:00:00Z' }),
        coupon({ voucher_id: 'sooner', face_value: 500, expires_at: '2026-02-01T00:00:00Z' }),
      ],
      500,
    )

    expect(result.parts[0].couponId).toBe('sooner')
  })
})

describe('narrowing', () => {
  it('never draws another stall’s coupons into the plan', () => {
    const result = plan(
      [
        coupon({ voucher_id: 'mine', face_value: 300 }),
        coupon({ voucher_id: 'theirs', face_value: 5000, issuer_id: OTHER_STALL }),
      ],
      1000,
    )

    // The other stall's 5000 would have covered it. It must not be touched: a
    // stall cannot honour a coupon it did not issue.
    expect(result.obstacle).toMatchObject({ kind: 'insufficient-value', available: 300 })
    expect(result.eligibleCount).toBe(1)
  })

  it('never draws another currency into the plan', () => {
    const result = plan(
      [
        coupon({ voucher_id: 'eur', face_value: 300 }),
        coupon({ voucher_id: 'xaf', face_value: 5000, face_unit: 'XAF', face_decimals: 0 }),
      ],
      1000,
    )

    expect(result.obstacle).toMatchObject({ kind: 'insufficient-value', available: 300 })
  })

  it('matches a stall id and a currency case-insensitively', () => {
    const result = plan(
      [coupon({ issuer_id: STALL.toUpperCase(), face_unit: 'eur', face_value: 500 })],
      500,
    )
    expect(result.obstacle).toBeNull()
  })

  /**
   * Normalisation has TWO sides, and only one was tested.
   *
   * The case above varies the coupon and holds the request at 'EUR', so an
   * implementation that normalised the coupon but not the request still passed
   * — mutation testing showed exactly that. A caller who writes `currency:
   * "eur"` is not making a mistake, and would otherwise be told they hold
   * nothing.
   */
  it('normalises the REQUESTED currency and stall, not just the coupon’s', () => {
    const held = [coupon({ issuer_id: STALL, face_unit: 'EUR', face_value: 500 })]

    expect(plan(held, 500, { currency: 'eur' }).obstacle).toBeNull()
    expect(plan(held, 500, { currency: '  EUR  ' }).obstacle).toBeNull()
    expect(plan(held, 500, { stallId: STALL.toUpperCase() }).obstacle).toBeNull()
  })

  it('never spends a redeemed or spent coupon', () => {
    for (const status of ['spent', 'redeemed']) {
      const result = plan([coupon({ face_value: 5000, status })], 500)
      expect(result.eligibleCount).toBe(0)
      expect(result.obstacle?.kind).toBe('insufficient-value')
    }
  })

  /**
   * The spend logic itself does NOT filter expired coupons — `planParts` will
   * happily build a part from one that lapsed years ago. The app filters them
   * in `couponsFor` before planning, so this narrowing is the only thing
   * standing between a caller and a plan the gateway would reject.
   */
  it('never spends an expired coupon, which the planner alone would allow', () => {
    const result = plan([coupon({ face_value: 5000, expires_at: '2025-01-01T00:00:00Z' })], 500)

    expect(result.eligibleCount).toBe(0)
    expect(result.obstacle?.kind).toBe('insufficient-value')
  })

  it('reads a numeric expiry, the form the redemption path writes', () => {
    const seconds = Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000)
    expect(eligibleCoupons([coupon({ expires_at: seconds })], STALL, 'EUR', NOW)).toHaveLength(0)
  })

  it('keeps a coupon with no expiry', () => {
    expect(eligibleCoupons([coupon({ expires_at: undefined })], STALL, 'EUR', NOW)).toHaveLength(1)
  })
})

describe('obstacles', () => {
  it('says insufficient when the holding does not add up', () => {
    const result = plan([coupon({ face_value: 300 })], 1000)

    expect(result.obstacle).toMatchObject({
      kind: 'insufficient-value',
      available: 300,
      requested: 1000,
    })
    expect(result.parts).toEqual([])
    // The caller's action is to acquire more coupons, and the wording says so.
    expect(result.obstacle?.detail).toContain('More coupons')
  })

  /**
   * The distinction the ticket is really about.
   *
   * A ratio of 200 means the coupon divides only in steps of 200, so 150 is
   * unreachable from a 1000 coupon that is nominally more than sufficient.
   * Waiting for more coupons of the same shape would never help.
   */
  it('says not-splittable when the holding is enough but the amount is unreachable', () => {
    const result = plan(
      [coupon({ face_value: 1000, token_amount: 5, issuance_ratio: 200 })],
      150,
    )

    expect(result.obstacle?.kind).toBe('not-splittable')
    expect(result.obstacle?.available).toBe(1000)
    expect(result.obstacle?.requested).toBe(150)
  })

  it('reports the step, so a caller learns which amounts are reachable', () => {
    const result = plan(
      [coupon({ face_value: 1000, token_amount: 5, issuance_ratio: 200 })],
      150,
    )
    expect(result.obstacle?.minimumStep).toBe(200)
  })

  /**
   * Simple shortfall is reported first on purpose. When a holding genuinely
   * does not add up, "cannot be split" is also true and far less useful.
   */
  it('prefers insufficient over not-splittable when both are true', () => {
    const result = plan(
      [coupon({ face_value: 100, token_amount: 5, issuance_ratio: 200 })],
      1000,
    )
    expect(result.obstacle?.kind).toBe('insufficient-value')
  })

  it('refuses to leave un-splittable dust behind', () => {
    // 1000 face on 5 sats: steps of 200. Asking 900 would leave 100, which is
    // below one step and cannot be split off.
    const result = plan(
      [coupon({ face_value: 1000, token_amount: 5, issuance_ratio: 200 })],
      900,
    )
    expect(result.obstacle?.kind).toBe('not-splittable')
  })

  it('treats an empty holding as insufficient rather than an error', () => {
    const result = plan([], 100)
    expect(result.obstacle).toMatchObject({ kind: 'insufficient-value', available: 0 })
    expect(result.eligibleCount).toBe(0)
  })
})

describe('planning is read-only', () => {
  /**
   * The property that makes it safe to ask before committing: planning twice
   * moves nothing and changes nothing.
   */
  it('returns the same answer twice and mutates no coupon', () => {
    const coupons = [
      coupon({ voucher_id: 'a', face_value: 500 }),
      coupon({ voucher_id: 'b', face_value: 700 }),
    ]
    const before = JSON.stringify(coupons)

    const first = plan(coupons, 900)
    const second = plan(coupons, 900)

    expect(second).toEqual(first)
    expect(JSON.stringify(coupons)).toBe(before)
  })
})
