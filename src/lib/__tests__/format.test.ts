import { describe, it, expect } from 'vitest'

import {
  currencyDecimals,
  formatDate,
  formatFace,
  formatSats,
  handleLabel,
  parseAmountToMinor,
  shortPubkey,
} from '../format'

describe('handleLabel', () => {
  it('drops the domain', () => {
    expect(handleLabel('song@staging.398ja.xyz')).toBe('@song')
  })

  it('leaves a value with no domain alone but for the prefix', () => {
    // Not a case the app produces — `nip05` is written as `name@domain` at
    // registration — but a kind-0 is publishable by anyone, and this string
    // lands in the DOM.
    expect(handleLabel('song')).toBe('@song')
  })
})

describe('formatDate', () => {
  it('reads epoch milliseconds and epoch seconds as the same moment', () => {
    // The wallet stores both: transaction timestamps are ms in practice,
    // voucher expires_at is seconds. Misreading ms as seconds yields 1970.
    expect(formatDate(1786525200000)).toBe(formatDate(1786525200))
    expect(formatDate(1786525200000)).toContain('2026')
  })

  it('reads ISO strings, which is what created_at holds', () => {
    expect(formatDate('2026-08-12T09:00:00.000Z')).toContain('2026')
  })

  it('includes the clock time, which tells same-day records apart', () => {
    expect(formatDate('2026-08-12T09:35:00.000Z')).toMatch(/\d:\d\d/)
  })

  it('returns empty for absent or unparseable input so callers can omit the row', () => {
    expect(formatDate(undefined)).toBe('')
    expect(formatDate(null)).toBe('')
    expect(formatDate('')).toBe('')
    expect(formatDate('not a date')).toBe('')
  })
})

describe('formatFace', () => {
  it('renders minor units against the unit decimals', () => {
    expect(formatFace(500, { unit: 'EUR', decimals: 2 })).toContain('5')
  })

  it('does not throw on a non-ISO currency like SAT', () => {
    // Intl rejects unknown currency codes; formatFace falls back rather than
    // letting a merchant's own unit crash the screen.
    expect(() => formatFace(1000, { unit: 'SAT', decimals: 0 })).not.toThrow()
    // Grouping separators are locale-dependent, so assert the unit and the
    // digits rather than an exact string.
    const formatted = formatFace(1000, { unit: 'SAT', decimals: 0 })
    expect(formatted).toContain('SAT')
    expect(formatted.replace(/\D/g, '')).toBe('1000')
  })
})

describe('formatSats', () => {
  it('groups thousands and never adds a currency symbol', () => {
    // Sats are a count, not a currency — the vanilla formatSats groups and
    // stops there, leaving the word to the caller.
    expect(formatSats(10000).replace(/\D/g, '')).toBe('10000')
    expect(formatSats(10000)).not.toContain('SAT')
    expect(formatSats(10000)).not.toMatch(/[€$₿]/)
    expect(formatSats(500)).toBe('500')
  })

  it('floors, because a proof cannot be divided below one sat', () => {
    expect(formatSats(199.9)).toBe('199')
  })

  it('renders zero and drops absent values', () => {
    expect(formatSats(0)).toBe('0')
    expect(formatSats(undefined)).toBe('')
    expect(formatSats(null)).toBe('')
    expect(formatSats(Number.NaN)).toBe('')
  })

  it('is not interchangeable with formatFace', () => {
    // formatFace(500, {unit:'SAT'}) gives "SAT 500" — wrong vocabulary and
    // wrong order. This is why backing needs its own formatter.
    expect(formatSats(500)).not.toBe(formatFace(500, { unit: 'SAT', decimals: 0 }))
  })
})

describe('shortPubkey', () => {
  it('shortens a full pubkey and leaves a short string alone', () => {
    expect(shortPubkey('a'.repeat(64))).toBe(`${'a'.repeat(8)}…aaaa`)
    expect(shortPubkey('short')).toBe('short')
  })
})

describe('currencyDecimals', () => {
  it('is 2 for the ordinary case', () => {
    expect(currencyDecimals('EUR')).toBe(2)
    expect(currencyDecimals('USD')).toBe(2)
  })

  it('is 0 for the zero-decimal currencies in the issuance list', () => {
    // Load-bearing for issuance, not cosmetic: one minor unit costs one sat, so
    // scaling XAF by 100 over-backs the coupon a hundredfold and the token
    // grows too large to deliver (a flat 413 from the DM endpoint).
    expect(currencyDecimals('JPY')).toBe(0)
    expect(currencyDecimals('XAF')).toBe(0)
    expect(currencyDecimals('XOF')).toBe(0)
  })

  it('falls back to 2 for a unit Intl does not know', () => {
    expect(currencyDecimals('SAT')).toBe(2)
    expect(currencyDecimals('')).toBe(2)
  })
})

describe('parseAmountToMinor', () => {
  it('scales by the currency decimals', () => {
    expect(parseAmountToMinor('5', 2)).toBe(500)
    expect(parseAmountToMinor('5.25', 2)).toBe(525)
    expect(parseAmountToMinor('500', 0)).toBe(500)
  })

  it('accepts a comma decimal mark', () => {
    // Most markets in the issuance currency list write it this way, and the
    // device keypad offers whichever the locale prefers.
    expect(parseAmountToMinor('5,25', 2)).toBe(525)
  })

  it('rounds rather than truncating', () => {
    // 1.15 * 100 is 114.99999999999999 in floating point; truncation would
    // silently undercharge by a cent.
    expect(parseAmountToMinor('1.15', 2)).toBe(115)
  })

  it('rejects anything that is not a positive number', () => {
    expect(parseAmountToMinor('', 2)).toBeNull()
    expect(parseAmountToMinor('0', 2)).toBeNull()
    expect(parseAmountToMinor('-5', 2)).toBeNull()
    expect(parseAmountToMinor('abc', 2)).toBeNull()
    expect(parseAmountToMinor('5.5.5', 2)).toBeNull()
  })
})
