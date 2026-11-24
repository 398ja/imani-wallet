import { describe, expect, it } from 'vitest'

import { parseOnlineShop } from '../onlineShop'
import { buildMerchantEvent, emptyMerchant, mergeMerchantEvent } from '../merchant'

const S = 'ab'.repeat(32)
const good = { url: 'https://shop.example', redeem_key: S, platform: 'woocommerce', since: 1767000000 }

describe('parseOnlineShop (#402 contract §4)', () => {
  it('reads a well-formed field', () => {
    expect(parseOnlineShop(good)).toEqual({ url: 'https://shop.example', redeemKey: S, platform: 'woocommerce', since: 1767000000 })
    expect(parseOnlineShop({ ...good, redeem_key: S.toUpperCase() })?.redeemKey).toBe(S)
  })

  it('reads every platform a shop module enrols as (#414: PrestaShop)', () => {
    for (const platform of ['woocommerce', 'wordpress', 'magento', 'shopify', 'prestashop']) {
      expect(parseOnlineShop({ ...good, platform })?.platform).toBe(platform)
    }
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'https://shop.example'],
    ['an array', [good]],
    ['http', { ...good, url: 'http://shop.example' }],
    ['a relative url', { ...good, url: '/shop' }],
    ['javascript', { ...good, url: 'javascript:alert(1)' }],
    ['a short key', { ...good, redeem_key: S.slice(2) }],
    ['a compressed key', { ...good, redeem_key: '02' + S }],
    ['a non-hex key', { ...good, redeem_key: 'zz'.repeat(32) }],
    ['an unknown platform', { ...good, platform: 'etsy' }],
    ['a fractional since', { ...good, since: 1.5 }],
    ['a string since', { ...good, since: '1767000000' }],
    ['no since', { url: good.url, redeem_key: S, platform: 'shopify' }],
  ])('refuses %s', (_name, raw) => {
    expect(parseOnlineShop(raw)).toBeNull()
  })
})

describe('the merchant record carries onlineShop', () => {
  const pubkey = 'cd'.repeat(32)

  it('parses it, and drops a malformed one', () => {
    const m = mergeMerchantEvent(emptyMerchant(pubkey), JSON.stringify({ active: true, online_shop: good }), 10)
    expect(m.onlineShop?.redeemKey).toBe(S)
    const bad = mergeMerchantEvent(m, JSON.stringify({ active: true, online_shop: { ...good, url: 'http://x' } }), 11)
    expect(bad.onlineShop).toBeUndefined()
    expect(bad.active).toBe(true)
  })

  it('round-trips through the published event', () => {
    const m = mergeMerchantEvent(emptyMerchant(pubkey), JSON.stringify({ online_shop: good }), 10)
    const event = buildMerchantEvent(m)
    expect(JSON.parse(event.content).online_shop).toEqual(good)
    expect(JSON.parse(buildMerchantEvent(emptyMerchant(pubkey)).content).online_shop).toBeUndefined()
  })
})
