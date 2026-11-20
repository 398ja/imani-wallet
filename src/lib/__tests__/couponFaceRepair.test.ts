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
import { sendFaceOf } from '../sendFace'

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

describe('#638: a row whose token is credited for 0 is dust', () => {
  // staging 2026-11-20: face 1 on 8 sats of a 407-face / 7020-sat GBP coupon, worth 0.46p.
  const dust = buildVoucherToken({ voucherId: 'v-d', faceValue: 407, unit: 'GBP', issuanceRatio: 0.05797720797720798, expiresAt: 1_900_000_000 }, [8], {}, KEY).token

  it('restates the 1-vs-0 row to 0, which the one-unit tolerance used to leave alone', () => {
    expect(credit(dust)).toBe(0)
    expect(restatedFace(row(dust, 1))).toBe(0)
  })

  it('rounds half up like the gateway: a token worth 0.58 of a unit sends as 1 and is left alone', () => {
    const t = buildVoucherToken({ voucherId: 'v-d2', faceValue: 407, unit: 'GBP', issuanceRatio: 0.05797720797720798, expiresAt: 1_900_000_000 }, [8, 2], {}, KEY).token
    expect(sendFaceOf(t, 1)).toMatchObject({ sendFace: 1, fullSend: true })
    expect(restatedFace(row(t, 1))).toBeNull()
    // Overstated past the tolerance, it is still restated, to 1, never to 0.
    expect(restatedFace(row(t, 5))).toBe(1)
  })

  it('never touches a dust row that is not active money', () => {
    expect(restatedFace(row(dust, 1, 'spent'))).toBeNull()
    expect(restatedFace(row(dust, 1, 'swapped_to_sats'))).toBeNull()
  })

  it('leaves a row already at 0 alone', () => {
    expect(restatedFace(row(dust, 0))).toBeNull()
  })
})
