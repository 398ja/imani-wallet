/**
 * @vitest-environment node
 *
 * What a Cashlink really takes, before it is made (#635). An NGN sat is worth more than a kobo, so on
 * the ordinary send an amount is sent as the fewest sats worth it, up to a sat more: that is what
 * leaves, as Send and Pay already say. The locked path carves exactly the request, so it takes that.
 */
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'
import type { VoucherRow } from '@imani/wallet-storage'

import { buildVoucherToken } from './voucherFixtures'
import { cashlinkDebit } from '../cashlinkDebit'
import { toVoucher } from '../merchants'

const KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(KEY))
const ME = 'e'.repeat(64)
const NOW_S = Math.floor(Date.now() / 1000)
const LATER = NOW_S + 90 * 86_400
const X = NOW_S + 7 * 86_400

/** One coupon row: `face` minor units of `unit` on `proofs` sats, at face / sats. */
function couponRow(unit: string, face: number, proofs: number[]): VoucherRow {
  const sats = proofs.reduce((s, p) => s + p, 0)
  const ratio = face / sats
  const token = buildVoucherToken({ voucherId: `v-${unit}`, faceValue: face, unit, faceDecimals: 2, issuanceRatio: ratio, expiresAt: LATER }, proofs, {}, KEY).token
  return {
    token_id: `t-${unit}`,
    voucher_id: `v-${unit}`,
    token,
    issuer_id: STALL,
    merchant_id: STALL,
    amount: sats,
    token_amount: sats,
    face_value: face,
    face_unit: unit,
    face_decimals: 2,
    issuance_ratio: ratio,
    backing_strategy: 'PROPORTIONAL',
    status: 'active',
    expires_at: LATER,
    created_at: '2026-11-02T00:00:00Z',
  } as unknown as VoucherRow
}

// 10 000.00 NGN on 7429 sats: a sat is worth about 134.6 kobo.
const ngn = () => couponRow('NGN', 1_000_000, [4096, 2048, 1024, 256, 4, 1])
// 850.00 NGN on 1000 sats: a sat is worth 85 kobo, so NGN 1.00 is 2 sats, NGN 1.70 (the owner's report).
const ngn85 = () => couponRow('NGN', 85_000, [512, 256, 128, 64, 32, 8])
const eur = () => couponRow('EUR', 1000, [8192, 4096, 1016])

function debit(row: VoucherRow, amount: number, direct: boolean) {
  return cashlinkDebit({ rows: [row], vouchers: [toVoucher(row)], payer: ME, stall: STALL, unit: row.face_unit as string, amount, x: X, nowS: NOW_S, direct })
}

describe('what a Cashlink takes', () => {
  it('NGN 1.00 on a coupon at 85 kobo a sat takes NGN 1.70, on either path', () => {
    // Arrange
    const row = ngn85()

    // Act
    const taken = [debit(row, 100, false), debit(row, 100, true)]

    // Assert
    expect(taken).toEqual([170, 170])
  })

  it('NGN 1500.00 on the ordinary send matches what Send and Pay show (1500.87)', () => {
    // Arrange
    const row = ngn()

    // Act
    const taken = debit(row, 150_000, false)

    // Assert
    expect(taken).toBe(150_087)
  })

  it('EUR, where a sat is worth less than a cent: exactly the request', () => {
    // Arrange
    const row = eur()

    // Act
    const taken = debit(row, 337, false)

    // Assert
    expect(taken).toBe(337)
  })

  it('never less than the request, whatever the path', () => {
    // Arrange
    const row = ngn()

    // Act
    const results = [100, 999, 150_000].flatMap((a) => [debit(row, a, true), debit(row, a, false)].map((t) => t - a))

    // Assert
    expect(results.every((d) => d >= 0)).toBe(true)
  })

  it('a nonsense amount is returned as it is, never thrown', () => {
    // Arrange
    const row = ngn()

    // Act
    const taken = debit(row, 0, true)

    // Assert
    expect(taken).toBe(0)
  })
})
