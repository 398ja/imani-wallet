/**
 * Tiers, limits and the sales meter (#407).
 *
 * Adversarial where it matters: a limit we cannot read must never read as "unlimited", an older
 * catalog must never replace a newer one, and two grants must never add up.
 */
import { describe, expect, it } from 'vitest'

import { verifyLicence } from '../verify'
import { licenceOf } from '../read'
import { DENIAL_REASONS, type LicenceGrant, type LicenceVoucher } from '../types'
import { acceptCatalog, amountIn, BUNDLED_CATALOG, parseCatalog, type TierCatalog } from '../catalog'
import { entitlementOf, maySell, periodStart, salesInPeriod } from '../entitlement'

const US = 'a'.repeat(64)
const CUSTOMER = 'c'.repeat(64)
const NOW = 1_800_000_000 // 2027-01-15T08:00:00Z
const DAY = 86_400

const licence = (over: Partial<LicenceVoucher> = {}): LicenceVoucher => ({
  subscriptionId: 'sub-1',
  issuerPublicKey: US,
  issuerSignature: 'sig',
  lockKey: CUSTOMER,
  mintLockKey: CUSTOMER,
  expiresAt: NOW + 30 * DAY,
  features: ['terminals'],
  ...over,
})
const opts = { issuerPublicKey: US, now: NOW, presenter: CUSTOMER, verifySignature: () => true }

const grant = (over: Partial<LicenceGrant> = {}): LicenceGrant => ({
  features: [],
  expiresAt: NOW + 30 * DAY,
  pilot: false,
  ...over,
})

const ask = (grants: LicenceGrant[], currency = 'GBP', catalog: TierCatalog = BUNDLED_CATALOG) =>
  entitlementOf({ catalog, grants, currency, now: NOW })

describe('valid_from', () => {
  it('refuses a licence before its window opens, as an answer', () => {
    const v = verifyLicence(licence({ validFrom: NOW + 1 }), opts)
    expect(v).toMatchObject({ granted: false, reason: DENIAL_REASONS.NOT_YET_VALID })
  })

  it('grants from the opening instant, and carries validFrom on the grant', () => {
    const v = verifyLicence(licence({ validFrom: NOW }), opts)
    expect(v.granted && v.grant.validFrom).toBe(NOW)
  })

  it('treats a licence with no validFrom (sold before #407) as valid from issue', () => {
    expect(verifyLicence(licence(), opts).granted).toBe(true)
  })
})

describe('a licence that lifts only a limit (a hand grant)', () => {
  it('verifies with no features when it names a limit', () => {
    const v = verifyLicence(licence({ features: [], limits: { sales: { period: 'window', amounts: { GBP: 200_00 } } } }), opts)
    expect(v.granted && v.grant.limits?.sales).toEqual({ period: 'window', amounts: { GBP: 200_00 } })
  })

  it('still refuses one that names neither a feature nor a limit', () => {
    expect(verifyLicence(licence({ features: [] }), opts)).toMatchObject({ reason: DENIAL_REASONS.NO_FEATURES })
  })
})

describe('reading limits out of signed metadata', () => {
  const read = (meta: object) =>
    licenceOf({
      issuerPublicKey: US,
      issuerSignature: 'sig',
      merchantMetadata: JSON.stringify({ subscription_id: 'sub-1', ...meta }),
      expiresAt: NOW + DAY,
    } as never)

  it('reads tier, valid_from, grant_kind and limits', () => {
    const l = read({
      tier: 'basic',
      valid_from: NOW,
      grant_kind: 'custom',
      limits: { sales: { period: 'month', amounts: { GBP: 1000_00 } }, terminals: 3 },
    })
    expect(l).toMatchObject({
      tier: 'basic',
      validFrom: NOW,
      grantKind: 'custom',
      limits: { sales: { period: 'month', amounts: { GBP: 1000_00 } }, terminals: 3 },
    })
  })

  it('reads an explicit null as unlimited', () => {
    expect(read({ features: ['api'], limits: { sales: null, terminals: null } })?.limits).toEqual({ sales: null, terminals: null })
  })

  it('never reads a garbled limit as unlimited: it is dropped', () => {
    const l = read({ features: ['terminals'], limits: { sales: { period: 'month', amounts: { GBP: 'lots' } }, terminals: -1 } })
    expect(l?.limits).toBeUndefined()
  })

  it('does not recognise metadata with an id but neither features nor limits', () => {
    expect(read({ limits: { sales: { period: 'year', amounts: { GBP: 1 } } } })).toBeNull()
  })
})

describe('the catalog', () => {
  const body = (over: object = {}) =>
    JSON.stringify({
      version: 2,
      overshoot_pct: 10,
      tiers: { free: { features: [], limits: { sales: { period: 'lifetime', amounts: { GBP: 150_00 } }, terminals: 1 } } },
      ...over,
    })
  const signed = (b: string) => ({ body: b, signature: 'sig' })

  it('adopts a newer catalog signed by us', () => {
    const v = acceptCatalog(signed(body()), { verifySignature: () => true, current: BUNDLED_CATALOG })
    expect(v.accepted && v.catalog.tiers.free.limits.sales).toEqual({ period: 'lifetime', amounts: { GBP: 150_00 } })
  })

  it('refuses an unsigned one before reading it', () => {
    let parsed = false
    const v = acceptCatalog(
      { body: '{', signature: 'x' },
      {
        verifySignature: () => {
          parsed = true
          return false
        },
        current: BUNDLED_CATALOG,
      },
    )
    expect(v).toMatchObject({ accepted: false, reason: 'bad-signature' })
    expect(parsed).toBe(true)
  })

  it('refuses a replay of an older or equal version', () => {
    const current = parseCatalog(body({ version: 5 }))!
    expect(acceptCatalog(signed(body({ version: 5 })), { verifySignature: () => true, current })).toMatchObject({ reason: 'older' })
    expect(acceptCatalog(signed(body({ version: 4 })), { verifySignature: () => true, current })).toMatchObject({ reason: 'older' })
  })

  it('refuses a catalog with any unreadable tier, or with no free tier', () => {
    expect(parseCatalog(body({ tiers: { free: { features: [], limits: { terminals: 'x' } } } }))).toBeNull()
    expect(parseCatalog(body({ tiers: { pro: { features: [], limits: {} } } }))).toBeNull()
  })

  it('converts the USD amount for a currency it does not list, at the fixed rate, rounding down', () => {
    const catalog = { fx: { XAF: { perUsd: 605.5, decimals: 0 } } }
    expect(amountIn({ USD: 100_00 }, 'XAF', catalog)).toBe(60550)
    expect(amountIn({ USD: 100_00, XAF: 50000 }, 'XAF', catalog)).toBe(50000)
    expect(amountIn({ GBP: 100_00 }, 'XAF', catalog)).toBeUndefined()
  })
})

describe('the effective entitlement', () => {
  it('is the free tier with no licence: 100 once, one till, no paid features', () => {
    const e = ask([])
    expect(e).toMatchObject({ tier: 'free', terminals: 1, features: [] })
    expect(e.sales).toMatchObject({ period: 'lifetime', amount: 100_00, periodStart: 0, overshoot: 10_00 })
  })

  it('takes Basic from the catalog: unlimited issuance, three tills (www.imani.casa/pricing)', () => {
    const e = ask([grant({ tier: 'basic', features: ['terminals'] })])
    expect(e).toMatchObject({ tier: 'basic', terminals: 3 })
    expect(e.sales).toBeNull()
  })

  it('meters a monthly tier from the 1st (UTC), when a catalog defines one', () => {
    const monthly: TierCatalog = {
      ...BUNDLED_CATALOG,
      tiers: { ...BUNDLED_CATALOG.tiers, basic: { features: ['terminals'], limits: { sales: { period: 'month', amounts: { GBP: 1000_00 } }, terminals: 3 } } },
    }
    const e = ask([grant({ tier: 'basic', features: ['terminals'] })], 'GBP', monthly)
    expect(e.sales).toMatchObject({ period: 'month', amount: 1000_00, periodStart: Date.UTC(2027, 0, 1) / 1000 })
  })

  it('removes every limit on Pro and unlocks API and e-commerce', () => {
    const e = ask([grant({ tier: 'pro', features: ['terminals', 'api', 'ecommerce'] })])
    expect(e.sales).toBeNull()
    expect(e.terminals).toBeNull()
    expect(e.features).toEqual(expect.arrayContaining(['api', 'ecommerce']))
  })

  it('takes the highest of overlapping grants and never adds them', () => {
    const custom = (amount: number) =>
      grant({ subscriptionId: `g${amount}`, limits: { sales: { period: 'window', amounts: { GBP: amount } } }, validFrom: NOW - DAY })
    const e = ask([custom(200_00), custom(150_00)])
    expect(e.sales).toMatchObject({ amount: 200_00, period: 'window', periodStart: NOW - DAY, source: 'g20000' })
  })

  it('lets a hand grant raise a free stall to 200 and keeps the free till count', () => {
    const e = ask([grant({ limits: { sales: { period: 'window', amounts: { GBP: 200_00 } } }, validFrom: NOW - DAY })])
    expect(e.sales?.amount).toBe(200_00)
    expect(e.terminals).toBe(1)
  })

  it('ignores a grant outside its own window', () => {
    expect(ask([grant({ tier: 'pro', validFrom: NOW + 1 })]).tier).toBe('free')
    expect(ask([grant({ tier: 'pro', expiresAt: NOW })]).tier).toBe('free')
  })

  it('keeps a licence sold before #407 at unlimited tills and Basic sales', () => {
    const e = ask([grant({ features: ['terminals'] })])
    expect(e.terminals).toBeNull()
    expect(e.sales).toBeNull()
  })

  it('refuses to sell rather than reading an unpriceable currency as unlimited', () => {
    expect(ask([], 'XAF').sales).toMatchObject({ amount: 0, overshoot: 0 })
  })
})

describe('the sales meter and the sell gate', () => {
  const free = ask([])
  const allowance = free.sales!

  it('counts only this currency, from the period start, refunds netted', () => {
    const used = salesInPeriod(
      [
        { at: NOW - DAY, amount: 40_00, currency: 'GBP' },
        { at: NOW, amount: 30_00, currency: 'GBP' },
        { at: NOW, amount: -10_00, currency: 'GBP' },
        { at: NOW, amount: 999_00, currency: 'EUR' },
      ],
      allowance,
    )
    expect(used).toBe(60_00)
  })

  it('starts a month at 00:00 UTC on the 1st', () => {
    expect(periodStart('month', Date.UTC(2027, 1, 28, 23, 59) / 1000)).toBe(Date.UTC(2027, 1, 1) / 1000)
  })

  it('allows a sale that ends inside the 10 % overshoot, and warns', () => {
    expect(maySell(free, 95_00, 15_00)).toMatchObject({ allowed: true, warn: true })
  })

  it('refuses a sale that would go past limit + overshoot, before it starts', () => {
    expect(maySell(free, 95_00, 15_01)).toMatchObject({ allowed: false, reason: 'sales-limit-reached', limit: 100_00 })
  })

  it('does not warn below 80 %', () => {
    expect(maySell(free, 10_00, 10_00)).toMatchObject({ allowed: true, warn: false })
  })

  it('never refuses on Pro', () => {
    const pro = ask([grant({ tier: 'pro', features: ['api'] })])
    expect(maySell(pro, 10 ** 12, 10 ** 9)).toMatchObject({ allowed: true, limit: null })
  })
})
