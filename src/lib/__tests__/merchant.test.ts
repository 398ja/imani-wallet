import { describe, it, expect } from 'vitest'

import {
  buildMerchantEvent,
  canTrade,
  emptyMerchant,
  isMerchant,
  mergeMerchantEvent,
  MERCHANT_D_TAG,
  MERCHANT_KIND,
  type MerchantProfile,
} from '../merchant'

const base = (over: Partial<MerchantProfile> = {}): MerchantProfile => ({
  ...emptyMerchant('a'.repeat(64)),
  categories: ['food'],
  businessType: 'Market garden',
  ...over,
})

describe('buildMerchantEvent', () => {
  it('is an addressable event carrying the imani:merchant d-tag', () => {
    const event = buildMerchantEvent(base())
    expect(event.kind).toBe(MERCHANT_KIND)
    expect(event.tags).toEqual([['d', MERCHANT_D_TAG]])
  })

  it('omits blank optional fields rather than asserting them empty', () => {
    // A replaceable event replaces its predecessor wholesale, so "" is a claim
    // that the field is blank, not an absence of a claim.
    const content = JSON.parse(buildMerchantEvent(base({ location: '   ' })).content)
    expect(content).not.toHaveProperty('location')
    expect(content.businessType).toBe('Market garden')
  })

  it('always carries the fields Sell and Redeem cannot work without', () => {
    const content = JSON.parse(buildMerchantEvent(base()).content)
    expect(content.issuanceCurrency).toBe('EUR')
    expect(content.voucherValidityDays).toBe(30)
    expect(content.categories).toEqual(['food'])
  })
})

describe('mergeMerchantEvent', () => {
  it('applies a newer event', () => {
    const merged = mergeMerchantEvent(
      base({ eventAt: 100 }),
      JSON.stringify({ businessType: 'Bakery' }),
      200,
    )
    expect(merged.businessType).toBe('Bakery')
    expect(merged.eventAt).toBe(200)
  })

  it('IGNORES an older event, so a stale read cannot revert a fresh edit', () => {
    // The guard that lib/profile.ts documents for kind-0, which was not
    // hypothetical there: reads and writes go to different stores.
    const current = base({ businessType: 'Bakery', eventAt: 200 })
    const merged = mergeMerchantEvent(current, JSON.stringify({ businessType: 'Old name' }), 100)
    expect(merged).toBe(current)
  })

  it('ignores an event of exactly the same age', () => {
    const current = base({ businessType: 'Bakery', eventAt: 200 })
    expect(mergeMerchantEvent(current, JSON.stringify({ businessType: 'Other' }), 200)).toBe(current)
  })

  it('leaves absent fields alone rather than wiping them', () => {
    const merged = mergeMerchantEvent(base({ location: 'North shops' }), JSON.stringify({}), 300)
    expect(merged.location).toBe('North shops')
    expect(merged.businessType).toBe('Market garden')
  })

  it('survives malformed content', () => {
    const current = base()
    expect(mergeMerchantEvent(current, 'not json', 300)).toBe(current)
  })

  it('drops non-string categories — the content is attacker-controllable', () => {
    const merged = mergeMerchantEvent(
      base(),
      JSON.stringify({ categories: ['food', 42, null, 'retail'] }),
      300,
    )
    expect(merged.categories).toEqual(['food', 'retail'])
  })

  it('only an explicit false deactivates', () => {
    expect(mergeMerchantEvent(base(), JSON.stringify({}), 300).active).toBe(true)
    expect(mergeMerchantEvent(base(), JSON.stringify({ active: false }), 300).active).toBe(false)
  })

  it('rejects a nonsense validity rather than issuing vouchers that never expire', () => {
    const merged = mergeMerchantEvent(
      base(),
      JSON.stringify({ voucherValidityDays: 'soon' }),
      300,
    )
    expect(merged.voucherValidityDays).toBe(30)
  })

  it('round-trips through build', () => {
    const original = base({ location: 'North shops', voucherValidityDays: 90 })
    const event = buildMerchantEvent(original)
    const merged = mergeMerchantEvent(emptyMerchant(original.pubkey), event.content, 500)

    expect(merged.businessType).toBe(original.businessType)
    expect(merged.location).toBe(original.location)
    expect(merged.categories).toEqual(original.categories)
    expect(merged.voucherValidityDays).toBe(90)
  })
})

describe('isMerchant', () => {
  it('is the whole role model: a live record, or nothing', () => {
    expect(isMerchant(null)).toBe(false)
    expect(isMerchant(base())).toBe(true)
    expect(isMerchant(base({ active: false }))).toBe(false)
  })
})

describe('canTrade', () => {
  const merchantPerms = ['coupon:issue', 'coupon:redeem', 'coupon:pay', 'coupon:receive']
  const customerPerms = ['coupon:pay', 'coupon:receive']

  it('needs the permission AND the shop', () => {
    expect(canTrade(merchantPerms, base())).toBe(true)
    expect(canTrade(merchantPerms, null)).toBe(false)
    expect(canTrade(merchantPerms, base({ active: false }))).toBe(false)
  })

  it('refuses a customer session even when a shop record is present', () => {
    // The record is what a stolen or stale local copy would give you; the
    // session is what the server actually granted.
    expect(canTrade(customerPerms, base())).toBe(false)
  })

  it('treats no permissions at all as a denial', () => {
    // Silence is not consent. This briefly returned true, to cover a deployed
    // gateway that resolved no roles at all; compose now pins one that does.
    expect(canTrade([], base())).toBe(false)
    expect(canTrade([], null)).toBe(false)
  })
})
