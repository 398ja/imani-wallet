/**
 * @vitest-environment jsdom
 *
 * The API and the app must plan the same spend from the same holding.
 *
 * This is the acceptance criterion that cannot be met by inspection. The app
 * narrows a holding through `couponsFor` (stored rows: drops redeemed, drops
 * expired, filters to one stall) and then a currency filter in `payRequest`,
 * before handing what is left to `selectVouchers`/`planParts`. The API narrows
 * through `eligibleCoupons` in `@imani/wallet-core`.
 *
 * Two implementations of "which coupons may take part" is exactly the drift the
 * shared package exists to prevent, and the only way to know they agree is to
 * run both over the same holdings and compare.
 *
 * jsdom because `merchants.ts` reaches into browser-shaped modules on import.
 * The functions under test are pure; only the module graph needs the DOM.
 */
import { describe, expect, it } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'
import { eligibleCoupons, planSpend } from '@imani/wallet-core'
import { selectVouchers, planParts } from '@imani/wallet-core'

import { couponsFor, toVoucher } from '../merchants'

const STALL = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

/** A stored row, the shape the app actually holds. */
const row = (over: Partial<VoucherRow> = {}): VoucherRow =>
  ({
    token_id: 'tid-1',
    voucher_id: 'c1',
    token: 'cashuB...',
    amount: 1000,
    face_value: 1000,
    face_unit: 'EUR',
    face_decimals: 2,
    token_amount: 1000,
    issuance_ratio: 1,
    backing_strategy: 'FULL',
    issuer_id: STALL,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as VoucherRow

/**
 * The app's own path to a plan, reproduced exactly: narrow the rows, convert,
 * filter to one currency, then ask the same two functions `deliver` asks.
 */
function appPlan(rows: VoucherRow[], stallId: string, currency: string, amount: number) {
  const mine = couponsFor(rows, stallId).map(toVoucher)
  const inUnit = mine.filter((v) => (v.face_unit ?? '').toUpperCase() === currency.toUpperCase())

  // `deliver`: one coupon if one will do, a bundle otherwise.
  const single = selectVouchers(inUnit, amount)
  if (single.length > 0) return { ids: [single[0].voucher_id], amounts: [amount] }

  const plan = planParts(inUnit, amount)
  if (plan.remaining > 0) return null
  return {
    ids: plan.parts.map((p) => p.voucher.voucher_id),
    amounts: plan.parts.map((p) => p.amount),
  }
}

/** The API's path, through the shared package. */
function apiPlan(rows: VoucherRow[], stallId: string, currency: string, amount: number) {
  const result = planSpend({
    coupons: rows.map(toVoucher) as never,
    stallId,
    currency,
    amount,
  })
  if (result.obstacle) return null
  return {
    ids: result.parts.map((p) => p.couponId),
    amounts: result.parts.map((p) => p.amount),
  }
}

/**
 * Holdings chosen to hit the boundaries a programmatic caller meets far more
 * often than a human: exact matches, amounts below a split step, mixed
 * currencies from one stall, and coupons that must not take part at all.
 */
const HOLDINGS: Array<{ name: string; rows: VoucherRow[] }> = [
  { name: 'empty', rows: [] },
  { name: 'one exact coupon', rows: [row({ voucher_id: 'a', face_value: 500 })] },
  { name: 'one larger coupon', rows: [row({ voucher_id: 'a', face_value: 5000 })] },
  {
    name: 'exact match beside a larger one',
    rows: [row({ voucher_id: 'big', face_value: 5000 }), row({ voucher_id: 'exact', face_value: 500 })],
  },
  {
    name: 'two that must be bundled',
    rows: [row({ voucher_id: 'a', face_value: 300 }), row({ voucher_id: 'b', face_value: 400 })],
  },
  {
    name: 'differing expiries',
    rows: [
      row({ voucher_id: 'later', face_value: 500, expires_at: 1893456000 }),
      row({ voucher_id: 'sooner', face_value: 500, expires_at: 1801440000 }),
    ],
  },
  {
    name: 'another stall present',
    rows: [
      row({ voucher_id: 'mine', face_value: 300 }),
      row({ voucher_id: 'theirs', face_value: 9000, issuer_id: OTHER }),
    ],
  },
  {
    name: 'another currency present',
    rows: [
      row({ voucher_id: 'eur', face_value: 300 }),
      row({ voucher_id: 'xaf', face_value: 9000, face_unit: 'XAF', face_decimals: 0 }),
    ],
  },
  {
    name: 'a redeemed coupon present',
    rows: [
      row({ voucher_id: 'live', face_value: 400 }),
      row({ voucher_id: 'burnt', face_value: 9000, status: 'redeemed' }),
    ],
  },
  {
    name: 'an expired coupon present',
    rows: [
      row({ voucher_id: 'live', face_value: 400 }),
      row({ voucher_id: 'lapsed', face_value: 9000, expires_at: 1577836800 }),
    ],
  },
  {
    name: 'a coarse split step',
    rows: [row({ voucher_id: 'coarse', face_value: 1000, token_amount: 5, issuance_ratio: 200 })],
  },
  {
    name: 'many small coupons',
    rows: Array.from({ length: 8 }, (_, i) =>
      row({ voucher_id: `s${i}`, token_id: `t${i}`, face_value: 125 }),
    ),
  },
]

const AMOUNTS = [1, 100, 150, 200, 300, 400, 500, 700, 900, 1000, 1500, 5000, 9999]

describe('the API plans what the app plans', () => {
  for (const { name, rows } of HOLDINGS) {
    for (const amount of AMOUNTS) {
      it(`agrees on ${amount} from ${name}`, () => {
        expect(apiPlan(rows, STALL, 'EUR', amount)).toEqual(appPlan(rows, STALL, 'EUR', amount))
      })
    }
  }
})

describe('the two narrowings agree on which coupons may take part', () => {
  for (const { name, rows } of HOLDINGS) {
    it(`selects the same coupons from ${name}`, () => {
      const app = couponsFor(rows, STALL)
        .map(toVoucher)
        .filter((v) => (v.face_unit ?? '').toUpperCase() === 'EUR')
        .map((v) => v.voucher_id)

      const api = eligibleCoupons(rows.map(toVoucher) as never, STALL, 'EUR', Date.now()).map(
        (v) => v.voucher_id,
      )

      expect([...api].sort()).toEqual([...app].sort())
    })
  }
})
