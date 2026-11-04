/**
 * The free tier's threshold in every merchant currency (#506).
 *
 * Three promises, each a way the wallet and the catalog could quietly drift apart:
 *  - the catalog the wallet ships and the one the subscription service publishes carry the SAME
 *    free-tier amounts, so a device that has never synced shows the limit the gateway enforces;
 *  - every currency the onboarding picker offers has an amount, so no stall is created that the
 *    free tier lets sell nothing (the currency cannot be changed later);
 *  - every amount is in the minor units the wallet mints in (`currencyDecimals`), so 65,000 XOF is
 *    not read as 650.00.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_CATALOG, entitlementOf, FREE_TIER_AMOUNTS, parseCatalog } from '@imani/licence'

import { allCurrencies, isMerchantCurrency, searchCurrencies } from '../currencies'
import { currencyDecimals } from '../format'
import { CURRENCIES } from '../merchant'

const PUBLISHED = parseCatalog(
  readFileSync(join(__dirname, '../../../services/subscription/catalog.json'), 'utf8'),
)!

describe('the free tier in every merchant currency', () => {
  it('is the same in the bundled catalog and the one the subscription service publishes', () => {
    expect(PUBLISHED.tiers.free.limits.sales).toEqual(BUNDLED_CATALOG.tiers.free.limits.sales)
    expect(PUBLISHED.tiers.free.limits.sales?.amounts).toEqual(FREE_TIER_AMOUNTS)
    // No exchange rate anywhere: a limit only moves with a new catalog version.
    expect(PUBLISHED.fx).toBeUndefined()
    expect(BUNDLED_CATALOG.fx).toBeUndefined()
  })

  it('has an amount for every currency the onboarding picker offers', () => {
    const offered = allCurrencies().map((c) => c.code)
    expect(offered.length).toBeGreaterThan(100)
    expect(offered.filter((code) => FREE_TIER_AMOUNTS[code] === undefined)).toEqual([])
    // The fallback list a runtime without Intl.supportedValuesOf shows, too.
    expect(CURRENCIES.filter((code) => FREE_TIER_AMOUNTS[code] === undefined)).toEqual([])
  })

  it('keeps out what Intl lists but no merchant trades in', () => {
    for (const code of ['XDR', 'XSU', 'CUC', 'KPW', 'SVC', 'HRK', 'SLL', 'ZWL']) {
      expect(isMerchantCurrency(code)).toBe(false)
      expect(searchCurrencies(code).map((c) => c.code)).not.toContain(code)
    }
  })

  it('is about 100 USD and a round number, in the minor units the wallet mints in', () => {
    const at = (code: string) => FREE_TIER_AMOUNTS[code] / 10 ** currencyDecimals(code)
    for (const code of ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD']) expect(at(code)).toBe(100)
    expect(at('XOF')).toBe(65_000)
    expect(at('XAF')).toBe(65_000)
    expect(at('NGN')).toBe(130_000)
    expect(at('KES')).toBe(12_000)
    expect(at('GHS')).toBe(1_100)
    expect(at('JPY')).toBe(15_000)
    expect(at('KWD')).toBe(31)
    for (const [code, minor] of Object.entries(FREE_TIER_AMOUNTS)) {
      expect(Number.isSafeInteger(minor) && minor > 0, code).toBe(true)
      // Two significant figures at most, so a merchant reads 130,000 and not 134,606.
      expect(Number(at(code).toPrecision(2)), code).toBe(at(code))
    }
  })

  it('lets a free stall in NGN sell up to its threshold plus the overshoot, and no further', () => {
    const e = entitlementOf({ catalog: PUBLISHED, grants: [], currency: 'NGN', now: 1_800_000_000 })
    expect(e.sales).toMatchObject({ amount: 13_000_000, overshoot: 1_300_000, currency: 'NGN' })
  })
})
