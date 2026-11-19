/**
 * @vitest-environment jsdom
 *
 * #551: a customer received €1.00 as two €0.50 parts and the balance rose by €0.99. Each part came
 * as several proofs, filed as rows whose faces are the part's exact value shared by largest
 * remainder (some 0-face, 1 sat), so the stored faces add up to 50 + 50 while the exact value is
 * a little under (49.9 c each). Flooring the voucher's exact total showed 99.
 */
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import type { VoucherRow } from '@imani/wallet-storage'
import { roundedOnceTotal, spendableTotal } from '../couponTotals'
import { apportion } from '../faceSplit'
import { toMerchants, walletTotals } from '../merchants'
import { exactFaceValue, parseVoucherToken } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

const KEY = schnorr.utils.randomSecretKey()
const NOW = 1_800_000_000
const RATIO = 0.0722
let n = 0

/** One received part: one row per proof, faces apportioned across the part as #384 files them. */
function receivedPart(sats: number[], voucherId = 'bart-eur', face = 1200): VoucherRow[] {
  const base = buildVoucherToken({ voucherId, faceValue: face, unit: 'EUR', issuanceRatio: RATIO, expiresAt: NOW + 90 * 86_400 }, [1], {}, KEY)
  const tokens = sats.map((s) => buildVoucherToken({ ...base.voucher }, [s], {}, KEY).token)
  const shares = apportion(tokens.map((t) => exactFaceValue(parseVoucherToken(t))))
  return tokens.map((token, i) => ({
    token_id: `r-${++n}`,
    voucher_id: voucherId,
    token,
    amount: sats[i],
    token_amount: sats[i],
    face_value: shares[i],
    face_unit: 'EUR',
    face_decimals: 2,
    issuer_id: base.voucher.issuerId,
    issuance_ratio: RATIO,
    status: 'active',
    expires_at: NOW + 90 * 86_400,
    created_at: '2026-11-07T00:00:00Z',
    updated_at: '',
  }) as VoucherRow)
}

describe('#551 split receives total what was received', () => {
  // 691 sats at 0.0722 c/sat is 49.89 c exactly: shares 37/9/2/1/0/0 sum to 50 (two 0-face proofs).
  const PART = [512, 128, 32, 16, 2, 1]

  it('€0.50 + €0.50, each as split proofs with 0-face proofs, totals exactly €1.00', () => {
    const rows = [...receivedPart(PART), ...receivedPart(PART)]
    expect(rows.filter((r) => r.face_value === 0).length).toBeGreaterThan(0)
    expect(rows.reduce((s, r) => s + (r.face_value ?? 0), 0)).toBe(100)
    expect(roundedOnceTotal(rows)).toBe(100)
    expect(walletTotals(toMerchants(rows))).toEqual([{ unit: 'EUR', decimals: 2, minor: 100 }])
    // What a spend may draw stays at the ledger's floor of the exact value (99.78 c), never above
    // the balance shown; the Pay and Send screens say why (`roundingShortfallNote`).
    expect(spendableTotal(rows)).toBe(99)
  })

  it('regression #384: a take-back of 256/16/4/1 sats (exactly 20.0 c) still totals €0.20', () => {
    const rows = receivedPart([256, 16, 4, 1])
    expect(rows.reduce((s, r) => s + (r.face_value ?? 0), 0)).toBe(20)
    expect(roundedOnceTotal(rows)).toBe(20)
  })

  it('never above the signed face', () => {
    const rows = [...receivedPart(PART, 'small', 60), ...receivedPart(PART, 'small', 60)]
    expect(roundedOnceTotal(rows)).toBe(60)
  })
})
