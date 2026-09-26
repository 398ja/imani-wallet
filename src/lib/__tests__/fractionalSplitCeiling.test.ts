import { describe, expect, it } from 'vitest'
import { checkCeiling, type PriorRedemption } from '@imani/redemption'

import { creditIsRounded, creditableFaceValue, parseVoucherToken } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

/**
 * A voucher split into parts, redeemed part by part against the ceiling.
 *
 * `creditableFaceValue` rounds `tokenAmount * issuanceRatio` PER PART. With a
 * non-integer ratio each part can round up by up to half a minor unit, so the
 * parts can sum to more than the signed face. Before #90 the ceiling never saw
 * a prior redemption and this could not bite; now it does, and an honest last
 * part must not be refused over rounding the wallet itself introduced.
 *
 * The numbers are real rather than contrived: the fixture's ratio is the one a
 * live PROPORTIONAL voucher carried, 1000 face units backed by 17820 proofs.
 * Splitting 17820 as 9 + 9 + 17802 rounds 0.505 + 0.505 + 998.99 to
 * 1 + 1 + 999 = 1001, one over the face. Without `perPartRounding` the last
 * part was refused (observed before the fix).
 */
const RATIO = 0.05611672278338945
const FACE = 1000

/** One part as the till sees it, through the shipping parser. */
function part(proofs: number, ratio = RATIO) {
  const { token } = buildVoucherToken({ issuanceRatio: ratio, faceValue: FACE }, [proofs])
  const parsed = parseVoucherToken(token)
  return { value: creditableFaceValue(parsed).faceValue, rounded: creditIsRounded(parsed) }
}

/** Presents every part in turn, the way the till does. Returns each verdict. */
function redeemAll(parts: number[], ratio = RATIO): boolean[] {
  const prior: PriorRedemption[] = []
  return parts.map((proofs) => {
    const { value, rounded } = part(proofs, ratio)
    const check = checkCeiling({
      signedFaceValue: FACE,
      requested: value,
      priorRedemptions: prior,
      perPartRounding: rounded,
    })
    if (check.allowed) prior.push({ amount: value, direction: 'in' })
    return check.allowed
  })
}

describe('a 3-part split with a fractional issuance ratio', () => {
  const parts = [9, 9, 17802]

  it('covers exactly the whole backing, so every part is honest', () => {
    expect(parts.reduce((a, b) => a + b, 0)).toBe(Math.round(FACE / RATIO))
  })

  it('rounds past the face, which is the problem', () => {
    expect(parts.map((p) => part(p).value)).toEqual([1, 1, 999])
  })

  it('lets every part through the ceiling, including the last', () => {
    expect(redeemAll(parts)).toEqual([true, true, true])
  })

  it('still refuses presenting the whole backing twice', () => {
    // The slack is at most half a unit per part. A second full presentation is
    // a whole face over, far beyond anything rounding can explain.
    expect(redeemAll([17820, 17820])).toEqual([true, false])
  })
})

describe('an integer ratio keeps the exact bound', () => {
  it('reports its credit as not rounded', () => {
    expect(part(400, 1).rounded).toBe(false)
    // Float noise is not rounding: 10 * 0.1 is 1.0000000000000002 in binary.
    expect(part(10, 0.1).rounded).toBe(false)
  })

  it('refuses one minor unit past the face', () => {
    expect(redeemAll([600, 401], 1)).toEqual([true, false])
  })
})
