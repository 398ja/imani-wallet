import { describe, expect, it } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'
import { countVouchers, groupByVoucher, voucherKey } from '../voucherCount'
import { vouchers as voucherNoun } from '../bundleWording'

const STALL = 'a'.repeat(64)
let seq = 0
function row(over: Partial<VoucherRow> = {}): VoucherRow {
  seq += 1
  return {
    token_id: `token-${seq}`,
    token: `cashuB${seq}`,
    amount: 100,
    face_value: 100,
    face_unit: 'EUR',
    face_decimals: 2,
    issuer_id: STALL,
    status: 'active',
    ...over,
  } as VoucherRow
}

describe('voucher counts are of vouchers, not stored rows', () => {
  it('counts one voucher filed as six proof rows as ONE voucher', () => {
    const rows = [566, 283, 35, 9, 4, 1].map((face) => row({ voucher_id: 'v-1', face_value: face }))
    expect(rows).toHaveLength(6)
    expect(countVouchers(rows)).toBe(1)
    expect(voucherNoun(countVouchers(rows))).toBe('1 voucher')
  })

  it('still counts two different vouchers as two', () => {
    expect(countVouchers([row({ voucher_id: 'v-1' }), row({ voucher_id: 'v-2' })])).toBe(2)
  })

  it('never merges rows it cannot identify', () => {
    expect(countVouchers([row({ voucher_id: undefined }), row({ voucher_id: '' })])).toBe(2)
  })

  it('never merges the same id across two stalls', () => {
    expect(countVouchers([row({ voucher_id: 'v-1' }), row({ voucher_id: 'v-1', issuer_id: 'b'.repeat(64) })])).toBe(2)
  })

  it('reads the issuer case-insensitively', () => {
    expect(voucherKey(row({ voucher_id: 'v', issuer_id: STALL.toUpperCase() }))).toBe(voucherKey(row({ voucher_id: 'v' })))
  })

  it('groups rows into vouchers in first-row order, keeping every row', () => {
    const a1 = row({ voucher_id: 'a' })
    const b = row({ voucher_id: 'b', face_value: 250 })
    const a2 = row({ voucher_id: 'a' })
    const groups = groupByVoucher([a1, b, a2])
    expect(groups.map((g) => g.rows)).toEqual([[a1, a2], [b]])
    expect(groups[1]!.faceValue).toBe(250)
  })

  it('a voucher of one row keeps its stored face', () => {
    expect(groupByVoucher([row({ voucher_id: 'x', face_value: 437 })])[0]!.faceValue).toBe(437)
  })
})
