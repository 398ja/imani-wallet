import { describe, expect, it } from 'vitest'
import { checkPart, cumulativeCredit, type PriorRedemption } from '@imani/redemption'

import { creditableFaceValue, exactFaceValue, parseVoucherToken } from '../voucherToken'
import { buildVoucherToken } from './voucherFixtures'

/**
 * A voucher split into parts, redeemed part by part against the ceiling.
 *
 * `creditableFaceValue` rounds `tokenAmount * issuanceRatio` PER PART, so with
 * a non-integer ratio the parts' rounded values can sum past the face (honest
 * case) or be inflated at will by splitting finely (attack case). The ledger
 * books the CUMULATIVE credit instead (`cumulativeCredit`), and both cases
 * below are decided by that one rule under the exact ceiling.
 *
 *  - Honest: the live fixture ratio, 1000 face backed by 17820 proofs, split
 *    9 + 9 + 17802. Rounded per part that is 1 + 1 + 999 = 1001 and the last
 *    part was refused. Cumulatively it books 0 + 1 + 999 = 1000.
 *  - Attack: ratio 0.5, 2000 one-sat proofs, each worth 0.5. Rounded per part
 *    each is 1, and the count-based slack of 1a87c4f let all 2000 through
 *    (2000 booked on a 1000 face, observed at that commit). Cumulatively the
 *    total booked is 1000.
 */
const FACE = 1000

/** One part as the till sees it, through the shipping parser. Memoised: signing is slow. */
const parts = new Map<string, { rounded: number; exact: number }>()
function part(proofs: number, ratio: number) {
  const key = `${proofs}@${ratio}`
  const hit = parts.get(key)
  if (hit) return hit
  const { token } = buildVoucherToken({ issuanceRatio: ratio, faceValue: FACE }, [proofs])
  const parsed = parseVoucherToken(token)
  const value = { rounded: creditableFaceValue(parsed).faceValue, exact: exactFaceValue(parsed) }
  parts.set(key, value)
  return value
}

/** Presents every part in turn the way the till does. Returns the total booked. */
function redeemAll(parts: number[], ratio: number): { booked: number; refused: number } {
  const prior: PriorRedemption[] = []
  let refused = 0
  for (const proofs of parts) {
    const { exact } = part(proofs, ratio)
    const { credit, check } = checkPart({ signedFaceValue: FACE, exact, priorRedemptions: prior })
    if (!check.allowed) {
      refused += 1
      continue
    }
    prior.push({ amount: credit, direction: 'in', exact })
  }
  return { booked: prior.reduce((sum, r) => sum + r.amount, 0), refused }
}

describe('an honest 3-part split at a fractional ratio', () => {
  const RATIO = 0.05611672278338945
  const parts = [9, 9, 17802]

  it('covers exactly the whole backing', () => {
    expect(parts.reduce((a, b) => a + b, 0)).toBe(Math.round(FACE / RATIO))
  })

  it('rounds past the face when each part is rounded alone, which is the problem', () => {
    expect(parts.map((p) => part(p, RATIO).rounded)).toEqual([1, 1, 999])
  })

  it('books the full face, every part accepted, in any order', () => {
    for (const order of [parts, [17802, 9, 9], [9, 17802, 9]]) {
      expect(redeemAll(order, RATIO)).toEqual({ booked: FACE, refused: 0 })
    }
  })

  it('still refuses presenting the whole backing twice', () => {
    expect(redeemAll([17820, 17820], RATIO)).toEqual({ booked: FACE, refused: 1 })
  })
})

describe('the many-tiny-parts attack', () => {
  it('books no more than the genuine value of 2000 one-sat parts at ratio 0.5', () => {
    // Each part is worth 0.5 and rounds to 1 on its own. 2000 of them are 1000
    // of genuine value, and that is all the ceiling may ever let through.
    expect(part(1, 0.5)).toEqual({ rounded: 1, exact: 0.5 })
    const { booked } = redeemAll(Array.from({ length: 2000 }, () => 1), 0.5)
    expect(booked).toBe(1000)
  })

  it('refuses a further tiny part once the genuine value is booked', () => {
    const { booked, refused } = redeemAll(Array.from({ length: 2004 }, () => 1), 0.5)
    expect(booked).toBe(1000)
    expect(refused).toBe(4)
  })

  it('books nothing for a lone part worth less than a unit', () => {
    expect(redeemAll([1], 0.5)).toEqual({ booked: 0, refused: 0 })
  })
})

describe('an integer ratio is unchanged', () => {
  it('books each part at its own value and refuses one unit past the face', () => {
    expect(redeemAll([600, 401], 1)).toEqual({ booked: 600, refused: 1 })
    expect(redeemAll([600, 400], 1)).toEqual({ booked: 1000, refused: 0 })
  })

  it('treats float noise as whole', () => {
    // 10 * 0.1 is 1.0000000000000002 in binary, and 17820 * RATIO is 999.99...
    expect(cumulativeCredit(part(10, 0.1).exact, [])).toBe(1)
    expect(cumulativeCredit(part(17820, 0.05611672278338945).exact, [])).toBe(1000)
  })
})
