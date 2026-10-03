import { describe, it, expect } from 'vitest'

import {
  CURRENT_CODE_ALPHABET,
  canonicaliseTypedClaimCode,
  normaliseTypedClaimCode,
  typedClaimCodeProblem,
} from '../claimCode'

/**
 * #141: each shape has its own alphabet. A current code draws on the portal's
 * `CashbackService.CODE_ALPHABET`, a legacy one is hex. Anything else is refused
 * here rather than spending a by-code request against the per-IP limit.
 */
describe('the code alphabet, per shape', () => {
  it('mirrors the portal alphabet exactly', () => {
    expect(CURRENT_CODE_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTVWXYZ')
    // Every character of it is accepted in a current code.
    for (let i = 0; i < CURRENT_CODE_ALPHABET.length; i++) {
      const c = CURRENT_CODE_ALPHABET[i]
      expect(canonicaliseTypedClaimCode(`CB-${c}AAAA-AAAAA`)).toBe(`CB-${c}AAAA-AAAAA`)
    }
  })

  it.each(['0', '1', 'O', 'I', 'L', 'U'])('refuses a current-shaped code containing %s', (c) => {
    expect(canonicaliseTypedClaimCode(`CB-AEQT${c}-MYJHY`)).toBeNull()
    expect(canonicaliseTypedClaimCode(`aeqt${c.toLowerCase()}myjhy`)).toBeNull()
  })

  it('does not map confusables to a guess', () => {
    // O is not read as Q or D, and 1 is not read as 7: the portal has not agreed to it.
    expect(normaliseTypedClaimCode('AEQTOMYJHY')).toBeNull()
  })

  it('accepts legacy hex codes, including 0 and 1', () => {
    expect(canonicaliseTypedClaimCode('CB-0A1B-01')).toBe('CB-0A1B-01')
    expect(canonicaliseTypedClaimCode('cb 10ff 00')).toBe('CB-10FF-00')
    expect(canonicaliseTypedClaimCode('0a1b01')).toBe('CB-0A1B-01')
  })

  it('refuses a legacy-shaped code with a non-hex character', () => {
    for (const typed of ['CB-ABCG-12', 'CB-ZZZZ-99', 'CB-A1B2-CO']) {
      expect(canonicaliseTypedClaimCode(typed)).toBeNull()
    }
  })

  it('canonicalises case and whitespace in both shapes', () => {
    expect(canonicaliseTypedClaimCode('  cb - aeqtj   myjhy\n')).toBe('CB-AEQTJ-MYJHY')
    expect(canonicaliseTypedClaimCode('\tCb-a1b2-c3 ')).toBe('CB-A1B2-C3')
  })

  it('accepts every shape a current code gets written down in', () => {
    for (const typed of ['CB-AEQTJ-MYJHY', 'CBAEQTJMYJHY', 'AEQTJMYJHY', 'AEQTJ-MYJHY', 'cb aeqtj myjhy']) {
      expect(canonicaliseTypedClaimCode(typed)).toBe('CB-AEQTJ-MYJHY')
    }
  })

  it('refuses every length that is neither shape', () => {
    for (const typed of ['', 'A1B2C', 'A1B2C3D', 'AEQTJMYJH', 'AEQTJMYJHYZ', 'CB']) {
      expect(canonicaliseTypedClaimCode(typed)).toBeNull()
    }
  })
})

describe('telling the customer why', () => {
  it('names the excluded characters in a full-length current code', () => {
    const problem = typedClaimCodeProblem('CB-AEQT0-MYJHI')
    expect(problem).toMatch(/never contain 0, I/)
    expect(problem).toMatch(/Check the receipt/)
  })

  it('explains a legacy-length code with a non-hex character', () => {
    expect(typedClaimCodeProblem('CB-ABCG-12')).toMatch(/0 to 9 and the letters A to F/)
  })

  it('stays quiet while typing and once the code reads', () => {
    expect(typedClaimCodeProblem('')).toBeNull()
    expect(typedClaimCodeProblem('AEQ')).toBeNull()
    expect(typedClaimCodeProblem('CB-AEQTJ-MYJHY')).toBeNull()
    expect(typedClaimCodeProblem('CB-0A1B-01')).toBeNull()
  })
})
