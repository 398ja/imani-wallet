/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import type { VoucherRow } from '@imani/wallet-storage'
import { restatedFace } from '../couponFaceRepair'
import { carveProofs } from '../checkoutCarve'
import { creditableFaceValue, parseVoucherToken } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

const KEY = schnorr.utils.randomSecretKey()
const credit = (t: string) => creditableFaceValue(parseVoucherToken(t)).faceValue

/** staging 2026-11-01: a coupon at bart's day rate, 1852 sats, from which a 45 c code took 512 + 128. */
function coupon(sats: number[], ratio = 0.06969334926324174) {
  return buildVoucherToken({ voucherId: 'v-1', faceValue: 700, unit: 'EUR', issuanceRatio: ratio, expiresAt: 1_900_000_000 }, sats, {}, KEY).token
}
const row = (token: string, face: number, status = 'active') => ({ token, face_value: face, status }) as Pick<VoucherRow, 'token' | 'face_value' | 'status'>

describe('a carve left the row overstated (staging 2026-11-01: 5.19 shown, 5.10 usable)', () => {
  it('the rest of a carved coupon is credited for less than the coupon was: the row is restated to it', () => {
    const before = coupon([1024, 512, 128, 128, 32, 16, 8, 4])
    const carved = carveProofs(before, 45)!
    expect(carved).not.toBeNull()
    expect(credit(carved.part)).toBe(45)
    // The old carve kept the coupon's face on the rest row: overstated by the part it gave the code.
    expect(restatedFace(row(carved.rest!, credit(before)))).toBe(credit(carved.rest!))
  })

  it('leaves a row within one minor unit alone (the gateway rounds a split that way)', () => {
    const t = coupon([1024, 512])
    expect(restatedFace(row(t, credit(t) + 1))).toBeNull()
    expect(restatedFace(row(t, credit(t)))).toBeNull()
  })

  it('never raises a row, and never touches a row that is not active money', () => {
    const t = coupon([1024, 512])
    expect(restatedFace(row(t, credit(t) - 20))).toBeNull()
    expect(restatedFace(row(t, credit(t) + 50, 'swapped_to_sats'))).toBeNull()
  })
})
