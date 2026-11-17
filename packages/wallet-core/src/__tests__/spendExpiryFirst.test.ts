/**
 * Owner report 2026-11-17: every send and every payment spends the soonest-expiring coupons first.
 *
 * The rows are the shape the wallet stores (perf/snapshots/coupons-20.json): `expires_at` in epoch
 * SECONDS, a number, mapped through the app's `toVoucher` the way `spendableFrom` does.
 *
 * The bug these pin: `selectVouchers` sorted by expiry, but only among coupons that each cover the
 * whole amount. Any one coupon big enough won, so a smaller coupon expiring sooner was never spent
 * while it could not cover a payment on its own, and lapsed.
 */
import { describe, it, expect } from 'vitest'
import type { Voucher } from '@imani/voucher-send'

import { chooseSpend, passedOver } from '../index'

const STALL = '7952939535a79edc46d86e103785cee6f8119e8533787de8352257b051548448'
const OTHER = '27aa1ecd8aa7ee6c0104fdb3dd0c0e700e55754212746d7a5774ac3c8e585a30'
const DAY = 86_400
const NOW_S = 1_796_000_000

/** A stored EUR row as `toVoucher` hands it to the planner (ISO expiry, ratio 1). */
const row = (id: string, face: number, expiresInDays: number | null, over: Partial<Voucher> = {}): Voucher =>
  ({
    voucher_id: id,
    token: `cashuB-${id}`,
    face_value: face,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: face,
    issuance_ratio: 1,
    issuer_id: STALL,
    status: 'active',
    ...(expiresInDays === null ? {} : { expires_at: new Date((NOW_S + expiresInDays * DAY) * 1000).toISOString() }),
    ...over,
  }) as Voucher

/** The raw stored shape: epoch seconds as a number (dmPoll's adapter, the snapshot). */
const rawRow = (id: string, face: number, expiresInDays: number): Voucher =>
  row(id, face, null, { expires_at: (NOW_S + expiresInDays * DAY) as unknown as string })

const ids = (choice: ReturnType<typeof chooseSpend>) =>
  choice.kind === 'single' ? [choice.candidates[0].voucher_id] : choice.plan.parts.map((p) => `${p.voucher.voucher_id}:${p.amount}`)

describe('chooseSpend: soonest-expiring first on every door', () => {
  it('single-coupon pay: the soonest coupon that covers the amount', () => {
    const wallet = [row('late', 1000, 300), row('soon', 1000, 10), row('mid', 1000, 90)]
    expect(chooseSpend(wallet, 500)).toEqual({ kind: 'single', candidates: expect.any(Array) })
    expect(ids(chooseSpend(wallet, 500))).toEqual(['soon'])
  })

  it('a smaller coupon expiring sooner is spent, with the rest from the next (the reported bug)', () => {
    // Before: "late" alone covered 500, so it was spent and "soon" waited to lapse.
    const wallet = [row('late', 1000, 300), row('soon', 200, 3)]
    expect(ids(chooseSpend(wallet, 500))).toEqual(['soon:200', 'late:300'])
  })

  it('reads the stored seconds-number expiry, not just ISO', () => {
    const wallet = [rawRow('late', 1000, 300), rawRow('soon', 200, 3)]
    expect(ids(chooseSpend(wallet, 500))).toEqual(['soon:200', 'late:300'])
  })

  it('multi-part bundle: parts are drawn in expiry order', () => {
    const wallet = [row('c', 300, 60), row('a', 300, 5), row('b', 300, 30)]
    expect(ids(chooseSpend(wallet, 800))).toEqual(['a:300', 'b:300', 'c:200'])
  })

  it('a coupon with no expiry goes last', () => {
    const wallet = [row('forever', 1000, null), row('dated', 1000, 400)]
    expect(ids(chooseSpend(wallet, 500))).toEqual(['dated'])
    const mixed = [row('forever', 1000, null), row('dated', 200, 400)]
    expect(ids(chooseSpend(mixed, 500))).toEqual(['dated:200', 'forever:300'])
  })

  it('tie-break at the same expiry: exact match, then smallest face, then voucher id', () => {
    expect(ids(chooseSpend([row('big', 1000, 10), row('exact', 500, 10)], 500))).toEqual(['exact'])
    expect(ids(chooseSpend([row('big', 1000, 10), row('small', 700, 10)], 500))).toEqual(['small'])
    expect(ids(chooseSpend([row('b', 700, 10), row('a', 700, 10)], 500))).toEqual(['a'])
    // Input order never decides it.
    expect(ids(chooseSpend([row('a', 700, 10), row('b', 700, 10)], 500))).toEqual(['a'])
  })

  it('one coupon still wins when nothing sooner exists', () => {
    // "small" expires later than "big", so the bundle has nothing to gain.
    expect(ids(chooseSpend([row('big', 1000, 10), row('small', 200, 50)], 500))).toEqual(['big'])
  })

  it('P2P send and gift link share the rule (same door, deliver): spent and passed-over agree', () => {
    const wallet = [row('late', 1000, 300), row('soon', 200, 3)]
    // Nothing sooner is left behind, so the pay screen has nothing to excuse.
    expect(passedOver(wallet, 500, { issuer: STALL, unit: 'EUR' })).toEqual([])
  })

  it('mixed issuers and currencies: only comparable coupons count, others are named as passed over', () => {
    const wallet = [
      row('mine', 1000, 300),
      row('other-stall', 200, 1, { issuer_id: OTHER }),
      row('xaf', 200, 2, { face_unit: 'XAF', face_decimals: 0 }),
    ]
    const eligible = wallet.filter((v) => v.issuer_id === STALL && v.face_unit === 'EUR')
    expect(ids(chooseSpend(eligible, 500))).toEqual(['mine'])
    expect(passedOver(wallet, 500, { issuer: STALL, unit: 'EUR' }).map((n) => [n.voucher.voucher_id, n.reason])).toEqual([
      ['other-stall', 'issuer'],
      ['xaf', 'unit'],
    ])
  })
})
