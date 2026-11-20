/**
 * #638: a coupon row says face 1, but its token holds 8 sats of a face-407 / 7020-sat coupon, worth
 * floor(8 * 407 / 7020) = 0 to the gateway. It expired first, so every send from that stall planned
 * it as a part and the gateway aborted the whole bundle (staging 2026-11-20).
 */
import { describe, it, expect } from 'vitest'
import type { Voucher } from '@imani/voucher-send'

import { chooseSpend, couponValue, planParts, selectVouchers, splitObstacle, valueHolding } from '../index'

const STALL = '7952939535a79edc46d86e103785cee6f8119e8533787de8352257b051548448'
const RATIO = 0.05797720797720798
const DAY = 86_400_000
const NOW = 1_796_000_000_000

const gbp = (id: string, face: number, sats: number, expiresInDays: number): Voucher =>
  ({
    voucher_id: id,
    token: `cashuB-${id}`,
    face_value: face,
    face_unit: 'GBP',
    face_decimals: 2,
    token_amount: sats,
    issuance_ratio: RATIO,
    backing_strategy: 'PROPORTIONAL',
    issuer_id: STALL,
    status: 'active',
    expires_at: new Date(NOW + expiresInDays * DAY).toISOString(),
  }) as Voucher

const dust = gbp('dust', 1, 8, 1)
// 926 at this ratio: 15972 sats credit floor(15972 * RATIO) = 926.
const big = gbp('big', 926, 15972, 30)

describe('#638 dust coupon', () => {
  it('values a coupon at what its token is credited for, never above its stored face', () => {
    expect(couponValue(dust)).toBe(0)
    expect(couponValue(big)).toBe(926)
    expect(couponValue(gbp('over', 2000, 15972, 30))).toBe(926)
    expect(couponValue(gbp('under', 500, 15972, 30))).toBe(500)
  })

  it('rounds half up like CouponRate.shownFaceOf: 10 sats (0.58p) are a penny the gateway sends', () => {
    expect(couponValue(gbp('ten', 1, 10, 1))).toBe(1)
    expect(chooseSpend([gbp('ten', 1, 10, 1)], 1).kind).toBe('single')
    // Not PROPORTIONAL: floor(1 / 0.0579...) = 17 sats, more than the 10 held, so it cannot pay 1.
    expect(couponValue({ ...gbp('ten', 1, 10, 1), backing_strategy: 'FULL' } as Voucher)).toBe(0)
  })

  it('never drops real money to 0: EUR, NGN, KES and legacy rows', () => {
    const at = (face: number, sats: number | undefined, ratio: number | undefined, unit = 'EUR') =>
      ({ ...gbp('x', face, sats ?? 0, 30), face_unit: unit, token_amount: sats, issuance_ratio: ratio }) as Voucher
    expect(couponValue(at(76, 1084, 0.06969334926324174))).toBe(76) // 75.55, half up
    expect(couponValue(at(128, 1, 128.3, 'NGN'))).toBe(128)
    expect(couponValue(at(99952, 27014, 3.7, 'KES'))).toBe(99952)
    expect(couponValue(at(2500, 19, 131.57894736842104))).toBe(2500) // a hair under, still its face
    // Legacy: no sats or no ratio, nothing to check against. The stored face stands.
    expect(couponValue(at(500, undefined, undefined))).toBe(500)
    expect(couponValue(at(500, 100, undefined))).toBe(500)
    expect(couponValue(at(500, undefined, 0.5))).toBe(500)
  })

  it('still spends the soonest-expiring coupon first when it can really pay', () => {
    const soon = gbp('soon', 300, 5175, 2) // 300.03 -> 300
    const plan = planParts([big, soon], 1000)
    expect(plan.parts.map((p) => [p.voucher.voucher_id, p.amount])).toEqual([['soon', 300], ['big', 700]])
    const single = chooseSpend([big, soon], 200)
    expect(single.kind).toBe('single')
    if (single.kind === 'single') expect(single.candidates[0].voucher_id).toBe('soon')
  })

  it('a 200 send is a single part from the 926, not a bundle with the dust', () => {
    const choice = chooseSpend([dust, big], 200)
    expect(choice.kind).toBe('single')
    if (choice.kind === 'single') expect(choice.candidates.map((v) => v.voucher_id)).toEqual(['big'])
    expect(planParts([dust, big], 200).parts.map((p) => p.voucher.voucher_id)).toEqual(['big'])
  })

  it('a 927 send is refused up front as not covered', () => {
    const choice = chooseSpend([dust, big], 927)
    expect(choice.kind).toBe('bundle')
    if (choice.kind === 'bundle') {
      expect(choice.plan.remaining).toBeGreaterThan(0)
      expect(choice.plan.parts.some((p) => p.voucher === dust)).toBe(false)
    }
    expect(splitObstacle([dust, big], 927)).toBeNull() // simply short: the screen says that
  })

  it('never offers the dust as a single coupon either', () => {
    expect(selectVouchers([dust], 1)).toEqual([])
    expect(planParts([dust], 1)).toEqual({ parts: [], remaining: 1 })
  })

  it('the holding does not count it as spendable', () => {
    const h = valueHolding([dust, big], NOW)
    expect(h.groups.reduce((s, g) => s + g.faceValue, 0)).toBe(926)
    expect(h.unusable.map((u) => [u.couponId, u.reason])).toEqual([['dust', 'no-value']])
  })
})
