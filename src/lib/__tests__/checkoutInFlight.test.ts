/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

import { moneyInFlight } from '../inFlightMoney'
import { withoutInFlight } from '../pay'
import { saveCheckoutCode, checkoutCodesKey, reserveCheckoutRefundIndices, type CheckoutCodeRecord } from '../checkoutCodeRecords'

/** #402: an outstanding checkout code's coupons are in flight: not spendable, and logout waits. */
const ME = 'ab'.repeat(32)

const record = (extra: Partial<CheckoutCodeRecord> = {}): CheckoutCodeRecord => ({
  id: 'c1', stall: 'b2'.repeat(32), shopKey: 'd4'.repeat(32), shopUrl: 'https://shop.example', platform: 'woocommerce',
  unit: 'EUR', decimals: 2, amount: 1000, x: 1, createdAt: 1, status: 'reserved',
  parts: [{ i: 0, amount: 1000, sourceTokenId: 'row-a', state: 'locked' }],
  ...extra,
})

const rows = [{ token_id: 'row-a' }, { token_id: 'row-b' }] as VoucherRow[]

beforeEach(() => localStorage.clear())

describe('checkout codes in flight', () => {
  it('a reserved code holds its coupons back from spending and blocks logout', () => {
    saveCheckoutCode(ME, record())
    expect(withoutInFlight(rows, ME).map((r) => r.token_id)).toEqual(['row-b'])
    expect(moneyInFlight(ME).codes).toBe(1)
  })

  it('a finished code holds nothing', () => {
    saveCheckoutCode(ME, record({ status: 'redeemed', done: true }))
    expect(withoutInFlight(rows, ME)).toHaveLength(2)
    expect(moneyInFlight(ME).codes).toBe(0)
  })

  it('an unreadable ledger blocks logout', () => {
    localStorage.setItem(checkoutCodesKey(ME), '{oops')
    expect(moneyInFlight(ME).codes).toBe(1)
  })

  it('refund indices are wallet-wide and never handed out twice', () => {
    expect(reserveCheckoutRefundIndices(ME, 2)).toEqual([0, 1])
    saveCheckoutCode(ME, record({ parts: [{ i: 5, amount: 1, state: 'locked' }] }))
    expect(reserveCheckoutRefundIndices(ME, 4)).toEqual([2, 3, 4, 6])
  })
})
