import { describe, expect, it } from 'vitest'

import { CODES_RETIRED, isRetiredCashbackCode } from '../cashlinkCopy'

/**
 * Typed codes are retired (wallet#268, owner 2026-10-15). During the transition a scanned or
 * pasted `CB-` code is recognised only to say so, never looked up.
 */
describe('isRetiredCashbackCode', () => {
  it('recognises both code shapes with the CB prefix, in any case and spacing', () => {
    for (const t of ['CB-ABCDE-FGHJK', 'cb-abcde-fghjk', ' CB ABCDE FGHJK ', 'CBABCDEFGHJK', 'CB-A1B2-C3', 'cba1b2c3']) {
      expect(isRetiredCashbackCode(t)).toBe(true)
    }
  })

  it('does not swallow things that are not codes: handles, npubs, payment requests, bare words', () => {
    for (const t of ['abcdefghij', 'alice@example.com', 'npub1' + 'q'.repeat(58), 'vreqAabc', 'CB-', 'CB-ABCDE-FGHJKX', 'cashback']) {
      expect(isRetiredCashbackCode(t)).toBe(false)
    }
  })

  it('says what to do instead, in the owner\'s words', () => {
    expect(CODES_RETIRED).toBe('Codes are no longer used. Ask the shop to show you the Cashlink QR again.')
  })
})
