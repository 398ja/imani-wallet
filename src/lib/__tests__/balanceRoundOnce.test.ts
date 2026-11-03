/**
 * @vitest-environment jsdom
 *
 * Staging 2026-11-02, "georges 8.98 vs 8.99": a 3 EUR checkout code from bart's 12.00 EUR voucher
 * left 13,008 sats of change as six coupon rows, one per re-signed proof. Each row rounded on its
 * own (566 + 283 + 35 + 9 + 4 + 1 = 898 c) where the exact value is 899.43 c.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import type { VoucherRow } from '@imani/wallet-storage'
import { roundedOnceTotal } from '../couponTotals'
import { toMerchants, totalFaceValue, walletTotals } from '../merchants'
import { checkoutPlan } from '../checkoutPlan'
import { creditableFaceValue, exactFaceValue, parseVoucherToken } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

const KEY = schnorr.utils.randomSecretKey()
const NOW = 1_800_000_000
const GEORGES_RATE = 0.0691443
const GEORGES_CHANGE = [8192, 4096, 512, 128, 64, 16]

let n = 0
/** One coupon row per proof amount, all of ONE voucher, each row's face its own credit. */
function rowsOf(sats: number[], ratio: number, face = 1200): VoucherRow[] {
  const built = buildVoucherToken({ voucherId: 'bart-12eur', faceValue: face, unit: 'EUR', issuanceRatio: ratio, expiresAt: NOW + 90 * 86_400 }, sats, {}, KEY)
  // One single-proof token per row, all of the same voucher id: the rows a code's change came back as.
  return sats.map((_, i) => {
    const token = buildVoucherToken({ ...built.voucher }, [sats[i]], {}, KEY).token
    return {
      token_id: `t-${++n}`,
      voucher_id: 'bart-12eur',
      token,
      amount: sats[i],
      token_amount: sats[i],
      face_value: creditableFaceValue(parseVoucherToken(token)).faceValue,
      face_unit: 'EUR',
      face_decimals: 2,
      issuer_id: built.voucher.issuerId,
      issuance_ratio: ratio,
      status: 'active',
      expires_at: NOW + 90 * 86_400,
      created_at: `2026-11-02T00:00:0${i}Z`,
      updated_at: '',
    } as VoucherRow
  })
}

beforeEach(() => localStorage.clear())

describe('balance rounded once per voucher (georges 8.98 vs 8.99)', () => {
  it('the georges case: six change rows total 8.99 EUR, not 8.98', () => {
    const rows = rowsOf(GEORGES_CHANGE, GEORGES_RATE)
    expect(rows.map((r) => r.face_value)).toEqual([566, 283, 35, 9, 4, 1])
    expect(rows.reduce((s, r) => s + (r.face_value ?? 0), 0)).toBe(898)
    expect(roundedOnceTotal(rows)).toBe(899)
    const merchants = toMerchants(rows)
    expect(totalFaceValue(merchants[0])).toBe(899)
    expect(walletTotals(merchants)).toEqual([{ unit: 'EUR', decimals: 2, minor: 899 }])
  })

  it('rounds the other way too: per-row rounding UP is not shown, or offered', () => {
    // 3 x 1 sat at 0.6 c/sat: each row rounds to 1 c (3 c), the voucher is worth 1.8 c: 1 c (floor).
    const rows = rowsOf([1, 1, 1], 0.6, 100)
    expect(rows.reduce((s, r) => s + (r.face_value ?? 0), 0)).toBe(3)
    expect(roundedOnceTotal(rows)).toBe(1)
    expect(walletTotals(toMerchants(rows))[0].minor).toBe(1)
  })

  it('a voucher held as one row is unchanged', () => {
    const [row] = rowsOf([13008], GEORGES_RATE)
    expect(row.face_value).toBe(899)
    expect(roundedOnceTotal([row])).toBe(899)
    // Even a stored figure off the token's credit by the gateway's rounding stays as stored.
    expect(roundedOnceTotal([{ ...row, face_value: 900 }])).toBe(900)
  })

  it('a code never offers more than the coupons cover', () => {
    for (const [sats, ratio] of [[GEORGES_CHANGE, GEORGES_RATE], [[1, 1, 1], 0.6], [[8, 4, 2, 1], 0.0691443 * 7.3]] as const) {
      const rows = rowsOf([...sats], ratio, 100_000)
      const perRow = rows.reduce((s, r) => s + (r.face_value ?? 0), 0)
      const exact = rows.reduce((s, r) => s + exactFaceValue(parseVoucherToken(r.token)), 0)
      const req = { payer: 'ee'.repeat(32), stallId: rows[0].issuer_id!, unit: 'EUR', x: NOW + 7 * 86_400, nowS: NOW }
      const plan = checkoutPlan({ ...req, rows, amount: 10_000_000 })
      const available = (plan.obstacle as { available: number }).available
      // Never above what each part is credited for, never above the ledger's floor of the exact value.
      expect(available).toBeLessThanOrEqual(perRow)
      expect(available).toBeLessThanOrEqual(Math.floor(exact + 1e-9))
      expect(available).toBe(Math.min(perRow, roundedOnceTotal(rows)))
      // And never above the balance shown.
      expect(available).toBeLessThanOrEqual(roundedOnceTotal(rows))
    }
  })
})
