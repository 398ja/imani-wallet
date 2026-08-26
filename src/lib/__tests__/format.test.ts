import { describe, it, expect } from 'vitest'

import {
  currencyDecimals,
  displayDecimals,
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
    // 'BEANS' is the real shape of this case: a merchant's own unit, where the
    // only defensible guess is 2. This used to assert SAT -> 2, which was
    // simply wrong — sats have no minor unit — and passed only because SAT is
    // not an ISO code so Intl threw. SAT is not an issuance currency (see
    // merchant.CURRENCIES), so nothing depended on that answer.
    expect(currencyDecimals('BEANS')).toBe(2)
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

describe('currencyDecimals — the issuance-side answer', () => {
  // This one decides BACKING, not just a label: at issuance_ratio 1.0 one minor
  // unit costs one sat, so answering 2 for a zero-decimal unit changes what the
  // coupon is worth. FCFA is not an ISO code, so Intl throws and the catch
  // returned 2 — the same hole displayDecimals had, on the side where it costs
  // money rather than pixels.
  it('resolves FCFA and sats without asking Intl', () => {
    expect(currencyDecimals('FCFA')).toBe(0)
    expect(currencyDecimals('fcfa')).toBe(0)
    expect(currencyDecimals('SAT')).toBe(0)
    expect(currencyDecimals('SATS')).toBe(0)
  })

  it('still defers to Intl for real ISO codes', () => {
    expect(currencyDecimals('XAF')).toBe(0)
    expect(currencyDecimals('JPY')).toBe(0)
    expect(currencyDecimals('EUR')).toBe(2)
    expect(currencyDecimals('USD')).toBe(2)
  })

  it("keeps 2 for a merchant's own unit, where no better answer exists", () => {
    expect(currencyDecimals('BEANS')).toBe(2)
  })
})

describe('the two resolvers must never disagree', () => {
  // currencyDecimals feeds ISSUANCE (what a coupon is backed with) and
  // displayDecimals feeds RENDERING (what the customer reads). If they answer
  // differently for one unit, the label contradicts the money. They are
  // separate functions for good reasons, so pin the overlap rather than
  // trusting that whoever edits one remembers the other.
  //
  // BTC is here because it is exactly how this went wrong once already: Intl
  // answers 2, java.util.Currency throws, and gateway-portal answered 0 — three
  // services, three answers, for one unit.
  const units = ['XAF', 'XOF', 'FCFA', 'JPY', 'EUR', 'USD', 'SAT', 'SATS', 'MSAT', 'BTC', 'KES']

  it.each(units)('agrees on %s when the stored row says 2', (unit) => {
    expect(displayDecimals(unit, 2)).toBe(currencyDecimals(unit))
  })

  // DEV-238 is about zero-decimal currencies generally, not four of them. The
  // wallet's picker offers every code Intl.supportedValuesOf('currency')
  // returns (~300), so a Korean merchant can select KRW. gateway-portal mints
  // from java.util.Currency; these must match it or a coupon is labelled with
  // decimals it was not minted with.
  const ISO_ZERO = ['XOF', 'RWF', 'KMF', 'CLP', 'BIF', 'PYG', 'ISK', 'KRW', 'XAF',
                    'GNF', 'UGX', 'VND', 'JPY', 'XPF', 'VUV', 'DJF']
  const ISO_THREE = ['OMR', 'BHD', 'KWD', 'LYD', 'IQD', 'JOD', 'TND']

  it.each(ISO_ZERO)('%s carries no minor unit', (code) => {
    expect(currencyDecimals(code)).toBe(0)
    expect(displayDecimals(code, 2)).toBe(0)
  })

  it.each(ISO_THREE)('%s carries three minor digits', (code) => {
    expect(currencyDecimals(code)).toBe(3)
    expect(displayDecimals(code, 2)).toBe(3)
  })

  it('pins the zero-decimal set explicitly', () => {
    for (const unit of ['XAF', 'XOF', 'FCFA', 'JPY', 'SAT', 'SATS', 'MSAT', 'BTC']) {
      expect(currencyDecimals(unit), `currencyDecimals(${unit})`).toBe(0)
      expect(displayDecimals(unit, 2), `displayDecimals(${unit})`).toBe(0)
    }
  })
})

describe('displayDecimals — historical rows must not render 100x wrong', () => {
  // The DEV-238 fix corrected faceDecimals at ISSUANCE. Every coupon minted
  // before it is still sitting in customers' wallets carrying face_decimals: 2,
  // including the zero-decimal currencies. If display trusts the row, a real
  // 2,500 XAF coupon reads "25.00" for the rest of its life and no amount of
  // fixing issuance helps it. This is the exact gap the spec reviewer flagged.
  it('overrides a stale face_decimals: 2 on a zero-decimal currency', () => {
    expect(displayDecimals('XAF', 2)).toBe(0)
    expect(displayDecimals('XOF', 2)).toBe(0)
    expect(displayDecimals('JPY', 2)).toBe(0)
  })

  it('renders the reported 2,500 XAF coupon as 2,500 and not 25.00', () => {
    const stale = { face_value: 2500, face_unit: 'XAF', face_decimals: 2 }
    const shown = formatFace(stale.face_value, {
      unit: stale.face_unit,
      decimals: displayDecimals(stale.face_unit, stale.face_decimals),
    })
    expect(shown).not.toContain('25.00')
    expect(shown).toContain('2,500')
  })

  // FCFA is what merchants actually type and is NOT an ISO code, so Intl throws
  // on it and the fallback would hand back the stale 2. Both reported defects
  // ("FCFA 0.04" for 4, "0.02 XAF" for 2) name this unit, so the fix is worth
  // nothing if it misses this case. Found by checking the shipped resolver
  // against real staging rows, not by reading the ISO list.
  it('handles FCFA, which is not an ISO code but is what merchants type', () => {
    expect(displayDecimals('FCFA', 2)).toBe(0)
    expect(displayDecimals('fcfa', 2)).toBe(0)
    expect(displayDecimals(' FCFA ', 2)).toBe(0)
  })

  it('treats sat denominations as whole units', () => {
    expect(displayDecimals('SAT', 2)).toBe(0)
    expect(displayDecimals('sats', 2)).toBe(0)
    expect(displayDecimals('MSAT', 2)).toBe(0)
  })

  it('leaves genuinely two-decimal currencies alone', () => {
    expect(displayDecimals('EUR', 2)).toBe(2)
    expect(displayDecimals('USD', 2)).toBe(2)
  })

  it("keeps the row's own answer for a merchant's non-ISO unit", () => {
    // Intl throws on "BEANS"; the merchant's record is the only answer there is.
    expect(displayDecimals('BEANS', 2)).toBe(2)
    expect(displayDecimals('STAMPS', 0)).toBe(0)
  })

  it('falls back safely when the row has no usable decimals', () => {
    expect(displayDecimals('BEANS', undefined)).toBe(0)
    expect(displayDecimals('BEANS', -1)).toBe(0)
    expect(displayDecimals(undefined, 2)).toBe(2)
  })
})
