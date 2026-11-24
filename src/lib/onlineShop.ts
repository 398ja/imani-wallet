/**
 * The stall's online shop, as its public profile announces it (#402, contract §4).
 *
 * ## Why fail-closed
 *
 * The `redeem_key` here is the key `S` every part of a checkout code is locked to. Whoever holds
 * `S` can spend those coupons, so this field decides where a customer's money goes. It arrives on a
 * kind-30078 `imani:merchant` record (ADR 0012), which is public and self-asserted, and the wallet
 * takes `S` from nowhere else (R7).
 *
 * So the reading is all or nothing. An object with an `https` url, a 64-hex x-only key, a platform
 * from the known list and an integer `since` is an online shop. Anything else, including a field
 * that is almost right, is no online shop at all: the stall simply offers no checkout code, which
 * costs a customer nothing, whereas a guessed or repaired key could cost them the coupons.
 */

export const ONLINE_SHOP_PLATFORMS = ['woocommerce', 'wordpress', 'magento', 'shopify', 'prestashop'] as const

export type OnlineShopPlatform = (typeof ONLINE_SHOP_PLATFORMS)[number]

export interface OnlineShop {
  /** The shop's address, always `https:`. */
  url: string
  /** `S`, x-only, lowercase hex. */
  redeemKey: string
  platform: OnlineShopPlatform
  /** When the stall connected the shop, epoch seconds. */
  since: number
}

const HEX64 = /^[0-9a-f]{64}$/i

/** The `online_shop` value of a merchant record, or null for anything but a well-formed one. */
export function parseOnlineShop(raw: unknown): OnlineShop | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const field = raw as Record<string, unknown>
  const { url, redeem_key: redeemKey, platform, since } = field
  if (typeof url !== 'string' || typeof redeemKey !== 'string' || typeof platform !== 'string') return null
  if (!HEX64.test(redeemKey)) return null
  if (!(ONLINE_SHOP_PLATFORMS as readonly string[]).includes(platform)) return null
  if (typeof since !== 'number' || !Number.isSafeInteger(since) || since < 0) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null
  return { url, redeemKey: redeemKey.toLowerCase(), platform: platform as OnlineShopPlatform, since }
}

/** The record form, for publishing the stall's own profile again without dropping the field. */
export function onlineShopField(shop: OnlineShop): Record<string, unknown> {
  return { url: shop.url, redeem_key: shop.redeemKey, platform: shop.platform, since: shop.since }
}
