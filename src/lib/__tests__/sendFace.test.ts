/**
 * The NGN overcharge: what a send from one coupon really takes, mirroring gateway-core's split.
 *
 * The vectors are the ones `VoucherSplitCalculatorProportionalCeilTest` pins on the gateway side,
 * so a drift between the two implementations fails here or there.
 */
import { describe, expect, it } from 'vitest'
import { debitNote, sendFaceOf } from '../sendFace'
import { buildVoucherToken } from './voucherFixtures'
import { creditableFaceValue, parseVoucherToken } from '../voucherToken'

/** 10 000.00 NGN on 7429 sats: about 134.6 kobo per sat. */
const NGN_FACE = 1_000_000
const NGN_SATS = 7429
const NGN_PROOFS = [4096, 2048, 1024, 256, 4, 1]
const ngn = () =>
  buildVoucherToken({ unit: 'NGN', faceValue: NGN_FACE, faceDecimals: 2, issuanceRatio: NGN_FACE / NGN_SATS }, NGN_PROOFS).token

/** 10.00 EUR at the staging ratio, where a sat is worth about 0.075 c. */
const eur = () =>
  buildVoucherToken({ unit: 'EUR', faceValue: 1000, faceDecimals: 2, issuanceRatio: 1000 / 13304 }, [8192, 4096, 1016]).token

describe('sendFaceOf', () => {
  it('takes the request exactly where a sat is worth less than a cent', () => {
    // Arrange
    const token = eur()

    // Act
    const face = sendFaceOf(token, 250)

    // Assert
    expect(face).toMatchObject({ sendFace: 250, keepFace: 750, fullSend: false })
  })

  it.each([
    // request, sats sent, change, what leaves
    [150_000, 1115, 849_913, 150_087],
    [100, 1, 999_865, 135],
    [500_000, 3715, 499_933, 500_067],
  ])('NGN %i kobo takes the fewest sats worth it, and what they leave (gateway parity)', (request, sats, keep, send) => {
    // Act
    const face = sendFaceOf(ngn(), request)

    // Assert
    expect(face).toEqual({ sendFace: send, keepFace: keep, sendSats: sats, fullSend: false })
  })

  it('NGN within a sat of the whole coupon sends the whole coupon, and says so', () => {
    // Act
    const face = sendFaceOf(ngn(), NGN_FACE - 50)

    // Assert
    expect(face).toEqual({ sendFace: NGN_FACE, keepFace: 0, sendSats: NGN_SATS, fullSend: true })
  })

  it('never reports a change the wallet would restate, across a sweep of NGN requests', () => {
    // The bug: the change was recorded as parent - request, its sats credited up to a sat less,
    // and couponFaceRepair restated it, so the balance fell by more than the send recorded.
    const token = ngn()
    for (let request = 100; request < NGN_FACE; request += 4_999) {
      // Act
      const face = sendFaceOf(token, request)!

      // Assert
      expect(face.sendFace + face.keepFace).toBe(NGN_FACE)
      expect(face.sendFace).toBeGreaterThanOrEqual(request)
      expect(face.sendFace - request).toBeLessThanOrEqual(Math.ceil(NGN_FACE / NGN_SATS) + 1)
      if (!face.fullSend) {
        const change = buildVoucherToken(
          { unit: 'NGN', faceValue: NGN_FACE, faceDecimals: 2, issuanceRatio: NGN_FACE / NGN_SATS },
          [NGN_SATS - face.sendSats],
        ).token
        const credit = creditableFaceValue(parseVoucherToken(change)).faceValue
        expect(Math.abs(face.keepFace - credit)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is undefined for more than the coupon, a bad amount, or a token that is not a voucher', () => {
    // Act + Assert
    expect(sendFaceOf(ngn(), NGN_FACE + 1)).toBeUndefined()
    expect(sendFaceOf(ngn(), 0)).toBeUndefined()
    expect(sendFaceOf(ngn(), 1.5)).toBeUndefined()
    expect(sendFaceOf(`cashuB${'o'.repeat(30)}`, 100)).toBeUndefined()
    expect(sendFaceOf(undefined, 100)).toBeUndefined()
  })
})

describe('debitNote', () => {
  const format = (minor: number) => `₦${(minor / 100).toFixed(2)}`

  it('says nothing when the send takes exactly its amount', () => {
    // Act + Assert
    expect(debitNote(150_000, 150_000, format)).toBeNull()
  })

  it('names the nearest amount and the difference before the tap', () => {
    // Act
    const note = debitNote(150_000, 150_087, format)

    // Assert
    expect(note).toContain('₦1500.00')
    expect(note).toContain('₦1500.87')
    expect(note).toContain('₦0.87 more')
  })
})
