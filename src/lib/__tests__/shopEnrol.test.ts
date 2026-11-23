import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { readShopEnrolCode, signShopEnrolCode, shopHost } from '../shopEnrol'
import { readEnrolmentCode } from '../terminalEnrolProof'

const SK = hexToBytes('00000000000000000000000000000000000000000000000000000000000000c3')
const S = bytesToHex(schnorr.getPublicKey(SK))
const NOW = 1_767_000_000

describe('the online shop enrolment code (#402 §0)', () => {
  it('round-trips, with a url holding a port and a path', () => {
    const code = signShopEnrolCode(SK, S, 'https://shop.example:8443/store', 'woocommerce', NOW)
    expect(code.startsWith(`imani-shop-enrol:1:${S}:https://shop.example:8443/store:woocommerce:${NOW}:`)).toBe(true)
    const read = readShopEnrolCode(code, NOW)
    expect(read).toMatchObject({ redeemKey: S, url: 'https://shop.example:8443/store', platform: 'woocommerce' })
  })

  it('carries the same proof a till does, so the gateway checks S as a terminal key', () => {
    const code = signShopEnrolCode(SK, S, 'https://shop.example', 'magento', NOW)
    const read = readShopEnrolCode(code, NOW)
    if (typeof read === 'string') throw new Error(read)
    const [, at, sig] = read.enrolmentProof.split(':')
    expect(readEnrolmentCode(`imani-terminal-key:1:${S}:${at}:${sig}`, NOW)).toMatchObject({ terminalPubkey: S })
  })

  it('reads a code the PrestaShop module signed (#414, imani-checkout-prestashop Enrolment::code)', () => {
    const php = `imani-shop-enrol:1:${S}:https://shop.example:prestashop:${NOW}:d71e7caa9981375ded36b3ac3b6159e809946936c7be896d3a7d645a4e6fcf217608362671696750cddd2667e0c0f8a413997e714d244e40fa6daf1fe31a4e21`
    expect(readShopEnrolCode(php, NOW)).toMatchObject({ redeemKey: S, url: 'https://shop.example', platform: 'prestashop' })
  })

  it.each([
    ['a till code', () => `imani-terminal-key:1:${S}:${NOW}:${'0'.repeat(128)}`, 'not-a-shop-code'],
    ['http', () => signShopEnrolCode(SK, S, 'http://shop.example', 'woocommerce', NOW), 'bad-url'],
    ['an unknown platform', () => signShopEnrolCode(SK, S, 'https://shop.example', 'woocommerce', NOW).replace(':woocommerce:', ':etsy:'), 'bad-platform'],
    ['another key', () => signShopEnrolCode(SK, S, 'https://shop.example', 'woocommerce', NOW).replace(S, 'ab'.repeat(32)), 'bad-signature'],
    ['a stale code', () => signShopEnrolCode(SK, S, 'https://shop.example', 'woocommerce', NOW - 3 * 86400), 'expired'],
  ])('refuses %s', (_n, make, why) => {
    expect(readShopEnrolCode(make(), NOW)).toBe(why)
  })

  it('names the host', () => {
    expect(shopHost('https://shop.example/x')).toBe('shop.example')
  })
})
