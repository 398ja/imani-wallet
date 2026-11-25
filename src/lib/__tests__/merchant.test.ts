import { describe, it, expect } from 'vitest'

import {
  buildMerchantEvent,
  canTrade,
  emptyMerchant,
  isMerchant,
  merchantFieldsValid,
  mergeMerchantEvent,
  validityChoices,
  validValidityDays,
  MAX_VALIDITY_DAYS,
  NEVER_EXPIRES,
  MERCHANT_D_TAG,
  MERCHANT_KIND,
  type MerchantFields,
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
    expect(content.voucherValidityDays).toBe(NEVER_EXPIRES)
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

  it('rejects a nonsense validity rather than rewriting the term a stall chose', () => {
    // Never-expiring is a legitimate term now, so the danger this guards has
    // inverted: it is no longer "a garbled event mints an eternal coupon" but
    // "a garbled event silently moves a stall off the term it published".
    // Either way the answer is to keep what the stall already had.
    const merged = mergeMerchantEvent(
      base({ voucherValidityDays: 45 }),
      JSON.stringify({ voucherValidityDays: 'soon' }),
      300,
    )
    expect(merged.voucherValidityDays).toBe(45)
  })

  it('rejects an out-of-range validity — the content is attacker-controllable', () => {
    // Now that this number is a default rather than a fixture, it reaches
    // `expiry_days` on every sale without anyone re-reading it.
    for (const voucherValidityDays of [-1, 5000, 45.5]) {
      const merged = mergeMerchantEvent(
        base({ voucherValidityDays: 45 }),
        JSON.stringify({ voucherValidityDays }),
        300,
      )
      expect(merged.voucherValidityDays).toBe(45)
    }
  })

  /**
   * The values that reach zero by coercion rather than by being it.
   *
   * `Number()` maps every one of these onto 0, and 0 is now a legitimate term,
   * so an event carrying `false` or `" "` could claim never-expiring on a
   * stall's behalf. Out-of-range numbers do not cover this: those fail on the
   * bound, while these arrive already looking like the answer.
   */
  it('rejects a validity that only reaches never-expiring through coercion', () => {
    for (const voucherValidityDays of [false, [], ' ', '\n', '0.0', '0x0', {}]) {
      const merged = mergeMerchantEvent(
        base({ voucherValidityDays: 45 }),
        JSON.stringify({ voucherValidityDays }),
        300,
      )
      expect(merged.voucherValidityDays).toBe(45)
    }
  })

  it('still takes a term a merchant typed as digits', () => {
    // The string path is narrowed above, so the form's own input must survive it.
    expect(validValidityDays('45')).toBe(45)
    expect(validValidityDays(' 45 ')).toBe(45)
    expect(validValidityDays('0')).toBe(NEVER_EXPIRES)
  })

  it('accepts a published never-expires term', () => {
    const merged = mergeMerchantEvent(
      base({ voucherValidityDays: 45 }),
      JSON.stringify({ voucherValidityDays: NEVER_EXPIRES }),
      300,
    )
    expect(merged.voucherValidityDays).toBe(NEVER_EXPIRES)
  })

  it('accepts a custom validity a merchant actually chose', () => {
    const merged = mergeMerchantEvent(base(), JSON.stringify({ voucherValidityDays: 45 }), 300)
    expect(merged.voucherValidityDays).toBe(45)
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

describe('validValidityDays', () => {
  it('takes whole days inside the bounds and nothing else', () => {
    expect(validValidityDays(1)).toBe(1)
    expect(validValidityDays(MAX_VALIDITY_DAYS)).toBe(MAX_VALIDITY_DAYS)
    expect(validValidityDays('45')).toBe(45)

    // Zero is the never-expires term, not a rejected day count.
    expect(validValidityDays(0)).toBe(NEVER_EXPIRES)

    expect(validValidityDays(-30)).toBeNull()
    expect(validValidityDays(MAX_VALIDITY_DAYS + 1)).toBeNull()
    // A typo that would date the coupon to the next decade.
    expect(validValidityDays(3000)).toBeNull()
    // Half a day is not a term anyone means to offer.
    expect(validValidityDays(45.5)).toBeNull()
    expect(validValidityDays('soon')).toBeNull()
    expect(validValidityDays('')).toBeNull()
    expect(validValidityDays(undefined)).toBeNull()
    expect(validValidityDays(Infinity)).toBeNull()
  })
})

describe('validityChoices', () => {
  it('offers the stall its own term first, then the presets', () => {
    expect(validityChoices(45)).toEqual([45, NEVER_EXPIRES, 30, 60, 90])
  })

  it('does not offer the same term twice', () => {
    expect(validityChoices(60)).toEqual([60, NEVER_EXPIRES, 30, 90])
  })
})

describe('merchantFieldsValid', () => {
  const fields = (over: Partial<MerchantFields> = {}): MerchantFields => ({
    active: true,
    categories: ['food'],
    issuanceCurrency: 'EUR',
    voucherValidityDays: 30,
    ...over,
  })

  it('blocks a save while a custom validity is half-typed', () => {
    expect(merchantFieldsValid(fields())).toBe(true)
    expect(merchantFieldsValid(fields({ voucherValidityDays: null }))).toBe(false)
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

/**
 * Whether a stall takes cards, as a stranger discovers it.
 *
 * This field is the only channel a visitor with no session has: every
 * `imani-merchant` endpoint is self-scoped, so `charges_enabled` is unreachable
 * for anyone but the merchant themselves. It therefore has to behave
 * conservatively in every direction a record can be wrong.
 */
describe('acceptsCards', () => {
  it('names PayPal only for a PayPal stall that takes cards, and reads it back', () => {
    // payment-adapter ADR 0002. A Stripe stall's record is unchanged (no field), so every record
    // published before PayPal reads as Stripe.
    const paypal = JSON.parse(buildMerchantEvent(base({ acceptsCards: true, cardProcessor: 'paypal' })).content)
    expect(paypal.cardProcessor).toBe('paypal')
    const stripe = JSON.parse(buildMerchantEvent(base({ acceptsCards: true, cardProcessor: 'stripe' })).content)
    expect('cardProcessor' in stripe).toBe(false)
    const off = JSON.parse(buildMerchantEvent(base({ acceptsCards: false, cardProcessor: 'paypal' })).content)
    expect('cardProcessor' in off).toBe(false)

    const now = Math.floor(Date.now() / 1000)
    expect(mergeMerchantEvent(base(), JSON.stringify({ acceptsCards: true, cardProcessor: 'paypal' }), now).cardProcessor).toBe('paypal')
    expect(mergeMerchantEvent(base({ cardProcessor: 'paypal' }), JSON.stringify({ acceptsCards: true }), now).cardProcessor).toBeUndefined()
    expect(mergeMerchantEvent(base(), JSON.stringify({ acceptsCards: true, cardProcessor: 'PayPal!' }), now).cardProcessor).toBeUndefined()
  })
  it('is published only when true', () => {
    const on = JSON.parse(buildMerchantEvent(base({ acceptsCards: true })).content)
    expect(on.acceptsCards).toBe(true)

    // Absent rather than `false`, so a stall that never connected Stripe and a
    // client too old to know the field publish the same thing.
    const off = JSON.parse(buildMerchantEvent(base({ acceptsCards: false })).content)
    expect('acceptsCards' in off).toBe(false)

    const unset = JSON.parse(buildMerchantEvent(base()).content)
    expect('acceptsCards' in unset).toBe(false)
  })

  it('reads back as true only from an explicit true', () => {
    const merged = mergeMerchantEvent(
      base(),
      JSON.stringify({ acceptsCards: true }),
      Math.floor(Date.now() / 1000),
    )
    expect(merged.acceptsCards).toBe(true)
  })

  it('goes false when a record stops asserting it', () => {
    // The disconnect case, and the reason this field does NOT follow `active`'s
    // "absent means keep what we had" rule. It tracks a live external fact:
    // a stall that disconnected Stripe republishes without the flag, and
    // holding the old value would keep a Buy button alive on a stall that can
    // no longer be paid.
    const connected = base({ acceptsCards: true })
    const merged = mergeMerchantEvent(
      connected,
      JSON.stringify({ categories: ['food'] }),
      Math.floor(Date.now() / 1000),
    )
    expect(merged.acceptsCards).toBe(false)
  })

  it('refuses a truthy non-boolean', () => {
    // A record is plaintext JSON on a public relay, so anything can appear in
    // it. Only a real `true` counts.
    for (const value of ['true', 1, {}, [], 'yes']) {
      const merged = mergeMerchantEvent(
        base(),
        JSON.stringify({ acceptsCards: value }),
        Math.floor(Date.now() / 1000),
      )
      expect(merged.acceptsCards).toBe(false)
    }
  })

  it('survives a round trip through the event', () => {
    const event = buildMerchantEvent(base({ acceptsCards: true }))
    const merged = mergeMerchantEvent(emptyMerchant('a'.repeat(64)), event.content, event.created_at)
    expect(merged.acceptsCards).toBe(true)
  })
})
