/**
 * #638 regression, staging 2026-11-20 (bundle 2f757a36…, part as_f8cf28a1b4534bdd): the stored row
 * of an 8-sat remnant of corda's 407-face / ratio 0.0579… GBP coupon claimed face 1 and carried no
 * issuance_ratio. The ratio was derived as face / sats = 0.125, so couponValue read 1, the planner
 * led the bundle with it and the gateway refused ("requested 1, available 0"). The fixture is that
 * part's real source token, read from staging's voucher_send.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'
import { couponValue, planParts } from '@imani/wallet-core'
import { issuanceRatioOf, toVoucher } from '../merchants'
import { restatedFace } from '../couponFaceRepair'

const token = readFileSync(new URL('./fixtures/dust638-as_f8cf28a1b4534bdd.token', import.meta.url), 'utf8').trim()

const row = {
  token_id: 'dust638',
  voucher_id: '47723ae8-9107-4084-9bce-aef9bbd65bf4',
  token,
  face_value: 1,
  face_unit: 'GBP',
  face_decimals: 2,
  token_amount: 8,
  backing_strategy: 'PROPORTIONAL',
  issuer_id: '1c4be7be8c27506e0ce4b7df7c051c7a7f50e650bdf8d9305a63324feafead1d',
  status: 'active',
  issuance_ratio: null,
} as unknown as VoucherRow

describe('#638 dust row without a stored ratio', () => {
  it('takes the ratio from the token, not face / sats', () => {
    expect(issuanceRatioOf(row)).toBeCloseTo(0.0579772, 6)
  })

  it('values the row at 0', () => {
    expect(couponValue(toVoucher(row))).toBe(0)
  })

  it('values it at 0 when the row also lacks token_amount (sats from the proofs)', () => {
    expect(couponValue(toVoucher({ ...row, token_amount: undefined, amount: undefined } as unknown as VoucherRow))).toBe(0)
  })

  it('is never planned into a bundle', () => {
    const big = toVoucher({ ...row, token_id: 'big', voucher_id: 'big', face_value: 299, token_amount: 5157, issuance_ratio: 0.05797720797720798 } as unknown as VoucherRow)
    const plan = planParts([toVoucher(row), big], 300)
    expect(plan.parts.every((p) => p.voucher !== undefined && p.voucher.voucher_id !== row.voucher_id)).toBe(true)
  })

  it('is restated to 0 by the face repair', () => {
    expect(restatedFace(row)).toBe(0)
  })
})
