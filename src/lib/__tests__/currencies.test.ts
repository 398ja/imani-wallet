import { describe, expect, it } from 'vitest'

import { currencyLabel, currencyName, searchCurrencies } from '../currencies'

describe('currencies', () => {
  it('names a currency and pairs the name with the code', () => {
    // Node's ICU names this "Euro"; other builds may differ in case or wording,
    // so the assertion is on the shape, not on one locale's exact string.
    expect(currencyName('EUR')).not.toBe('EUR')
    expect(currencyLabel('EUR')).toBe(`${currencyName('EUR')} (EUR)`)
  })

  it('shows the code alone when there is no name for it', () => {
    // Not a real ISO code, so `DisplayNames.of` hands it back unchanged — and
    // "ZZZ (ZZZ)" would be nonsense.
    expect(currencyLabel('ZZZ')).toBe('ZZZ')
  })

  it('ranks an exact code above the names that merely contain it', () => {
    const [first] = searchCurrencies('eur')
    expect(first.code).toBe('EUR')
  })

  it('finds a currency by typing its name', () => {
    expect(searchCurrencies('kenyan').map((c) => c.code)).toContain('KES')
  })

  it('offers the common list before anything is typed, and nothing for gibberish', () => {
    expect(searchCurrencies('').map((c) => c.code)).toContain('EUR')
    expect(searchCurrencies('qqqqzzz')).toEqual([])
  })

  it('never returns more than the limit', () => {
    // "a" matches most of the list; the dropdown must stay a dropdown.
    expect(searchCurrencies('a').length).toBeLessThanOrEqual(8)
  })
})
