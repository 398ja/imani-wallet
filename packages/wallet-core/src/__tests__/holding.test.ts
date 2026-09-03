/**
 * Valuing a holding, as pure functions.
 *
 * No server, no browser, no clock. `valueHolding` takes `now` as an argument
 * precisely so expiry can be tested at an instant rather than around one.
 */
import { describe, expect, it } from 'vitest'

import { valueHolding, stallKey } from '../holding'

const STALL_A = 'a'.repeat(64)
const STALL_B = 'b'.repeat(64)

/** A spendable coupon, overridable field by field. */
const coupon = (over: Record<string, unknown> = {}) =>
  ({
    voucher_id: 'c1',
    token: 'cashuBo...',
    face_value: 1000,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 500,
    backing_strategy: 'FULL',
    issuer_id: STALL_A,
    status: 'active',
    ...over,
  }) as never

const NOW = Date.parse('2026-01-01T00:00:00Z')

describe('grouping', () => {
  it('groups one stall’s coupons in one currency together', () => {
    const { groups } = valueHolding(
      [coupon({ voucher_id: 'a' }), coupon({ voucher_id: 'b', face_value: 250 })],
      NOW,
    )

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      stallId: STALL_A,
      currency: 'EUR',
      faceValue: 1250,
      couponCount: 2,
    })
  })

  /**
   * The reason this endpoint returns a breakdown at all. A coupon is a claim on
   * one stall, so a combined figure describes money that could pay for nothing.
   */
  it('never sums two stalls together', () => {
    const { groups } = valueHolding(
      [coupon({ issuer_id: STALL_A }), coupon({ issuer_id: STALL_B })],
      NOW,
    )

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.faceValue)).toEqual([1000, 1000])
    expect(new Set(groups.map((g) => g.stallId))).toEqual(new Set([STALL_A, STALL_B]))
  })

  it('never sums two currencies from one stall together', () => {
    const { groups } = valueHolding(
      [coupon({ face_unit: 'EUR' }), coupon({ face_unit: 'XAF', face_decimals: 0 })],
      NOW,
    )

    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.stallId === STALL_A)).toBe(true)
    expect(new Set(groups.map((g) => g.currency))).toEqual(new Set(['EUR', 'XAF']))
  })

  it('treats currency case-insensitively, so one stall’s eur and EUR are one group', () => {
    const { groups } = valueHolding(
      [coupon({ face_unit: 'eur' }), coupon({ face_unit: 'EUR' })],
      NOW,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].currency).toBe('EUR')
  })

  /**
   * Mirrors `issuerKey` in the app. A raw-vs-normalised comparison there made
   * real coupons invisible on a stall's page while its card counted them.
   */
  it('treats a stall id case-insensitively', () => {
    const { groups } = valueHolding(
      [coupon({ issuer_id: STALL_A }), coupon({ issuer_id: STALL_A.toUpperCase() })],
      NOW,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].couponCount).toBe(2)
  })

  /**
   * A missing unit is NOT quietly called satoshis: that would merge it into a
   * real group and misstate a balance a caller acts on.
   */
  it('reports a missing currency as UNKNOWN rather than defaulting it', () => {
    const { groups } = valueHolding([coupon({ face_unit: '  ' })], NOW)
    expect(groups[0].currency).toBe('UNKNOWN')
  })

  it('keeps a coupon with no issuer visible under a known key', () => {
    const { groups } = valueHolding([coupon({ issuer_id: undefined })], NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].stallId).toBe('unknown')
  })

  it('orders groups largest first, and totally, so equal holdings serialise alike', () => {
    const holding = [
      coupon({ issuer_id: STALL_B, face_value: 100 }),
      coupon({ issuer_id: STALL_A, face_value: 900 }),
      coupon({ issuer_id: STALL_A, face_unit: 'XAF', face_value: 900 }),
    ]
    const first = valueHolding(holding, NOW).groups
    const second = valueHolding([...holding].reverse(), NOW).groups

    expect(first[0].faceValue).toBe(900)
    // Same holding in a different order must produce the same response, or a
    // caller diffing two reads sees changes that did not happen.
    expect(second).toEqual(first)
  })
})

describe('unusable coupons', () => {
  it('reports a spent coupon rather than counting or dropping it', () => {
    const result = valueHolding([coupon({ voucher_id: 'gone', status: 'spent' })], NOW)

    expect(result.groups).toHaveLength(0)
    expect(result.unusable).toEqual([{ couponId: 'gone', reason: 'spent' }])
  })

  it('reports a redeemed coupon as spent, because its proofs are equally burnt', () => {
    const result = valueHolding([coupon({ status: 'redeemed' })], NOW)
    expect(result.unusable[0].reason).toBe('spent')
  })

  it('reports an expired coupon', () => {
    const result = valueHolding(
      [coupon({ expires_at: '2025-01-01T00:00:00Z' })],
      NOW,
    )
    expect(result.groups).toHaveLength(0)
    expect(result.unusable[0].reason).toBe('expired')
  })

  /**
   * `expires_at` is TYPED as a string and written as a number — seconds or
   * milliseconds — by the redemption path. A parser that trusted the type would
   * call a long-lapsed coupon live and put dead money in a caller's balance.
   * `spend.ts` carries the same warning over the same field.
   */
  it('reads a numeric expiry in seconds, not just an ISO string', () => {
    const result = valueHolding(
      [coupon({ expires_at: Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000) })],
      NOW,
    )
    expect(result.unusable[0].reason).toBe('expired')
  })

  it('reads a numeric expiry in milliseconds', () => {
    const result = valueHolding(
      [coupon({ expires_at: Date.parse('2025-01-01T00:00:00Z') })],
      NOW,
    )
    expect(result.unusable[0].reason).toBe('expired')
  })

  it('counts a coupon expiring in the future as spendable', () => {
    const result = valueHolding([coupon({ expires_at: '2027-01-01T00:00:00Z' })], NOW)
    expect(result.groups).toHaveLength(1)
    expect(result.unusable).toHaveLength(0)
  })

  it('counts a coupon with no expiry as spendable', () => {
    const result = valueHolding([coupon({ expires_at: undefined })], NOW)
    expect(result.groups).toHaveLength(1)
  })

  it('reports a zero-value coupon rather than a group worth nothing', () => {
    const result = valueHolding([coupon({ face_value: 0 })], NOW)
    expect(result.groups).toHaveLength(0)
    expect(result.unusable[0].reason).toBe('no-value')
  })

  it('reports a coupon with no token, whatever its status claims', () => {
    const result = valueHolding([coupon({ token: '', status: 'active' })], NOW)
    expect(result.unusable[0].reason).toBe('no-token')
  })

  /**
   * The property a reconciler needs: nothing supplied is unaccounted for. A
   * program told about fewer coupons than it sent has to diff the sets to find
   * out why, and will most likely assume its request was mangled.
   */
  it('accounts for every coupon supplied, in one bucket or the other', () => {
    const holding = [
      coupon({ voucher_id: '1' }),
      coupon({ voucher_id: '2', status: 'spent' }),
      coupon({ voucher_id: '3', expires_at: '2025-01-01T00:00:00Z' }),
      coupon({ voucher_id: '4', face_value: 0 }),
      coupon({ voucher_id: '5', issuer_id: STALL_B }),
    ]
    const result = valueHolding(holding, NOW)

    const grouped = result.groups.reduce((n, g) => n + g.couponCount, 0)
    expect(grouped + result.unusable.length).toBe(holding.length)
    expect(result.couponCount).toBe(holding.length)
  })
})

describe('an empty holding', () => {
  it('is a valid answer rather than an error', () => {
    expect(valueHolding([], NOW)).toEqual({ groups: [], unusable: [], couponCount: 0 })
  })
})

describe('stallKey', () => {
  it('lowercases a hex pubkey', () => {
    expect(stallKey(STALL_A.toUpperCase())).toBe(STALL_A)
  })

  it('leaves an npub alone, because it looks decodable and is not', () => {
    expect(stallKey('npub1abc')).toBe('npub1abc')
  })

  it('maps a missing issuer to a visible key', () => {
    expect(stallKey(undefined)).toBe('unknown')
    expect(stallKey('')).toBe('unknown')
  })
})
