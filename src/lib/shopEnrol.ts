import { signEnrolmentCode, readEnrolmentCode, enrolmentProofHeader } from './terminalEnrolProof'
import { ONLINE_SHOP_PLATFORMS, parseOnlineShop, type OnlineShop, type OnlineShopPlatform } from './onlineShop'

/**
 * An online shop's enrolment code (#402 §0): what the shop's plugin shows the stall owner so the
 * owner can enrol the shop as a REDEEM-ONLY terminal (ADR 0005), never an issuing one.
 *
 *     imani-shop-enrol:1:<S hex>:<url>:<platform>:<created_at>:<sig>
 *
 * `S` is the key the plugin generated at setup. `created_at` and `sig` are exactly the terminal
 * enrolment proof (`terminalEnrolProof.ts`): BIP-340 by `S` over the terminal enrolment digest, so
 * gateway-customer accepts `S` as a key created AS a terminal (inv-terminal-not-merchant) through
 * the same `X-Imani-Terminal-Enrolment` header a till uses. The plugin signs it with `S`; nothing
 * else in the code is secret.
 *
 * The url and platform are NOT covered by the signature (the gateway's digest has no room for
 * them). They are a proposal the owner reads and confirms on screen, and the stall then signs them
 * into its own profile, which is the only place a customer's wallet reads them from (R7).
 *
 * The url sits in the middle and contains colons, so the code is read from both ends: the prefix
 * and `S` from the left, the proof and platform from the right, and the url is what remains.
 */

export const SHOP_ENROL_PREFIX = 'imani-shop-enrol:1:'

export type ShopEnrolRefusal = 'not-a-shop-code' | 'bad-url' | 'bad-platform' | 'bad-signature' | 'expired'

export interface ShopEnrolment {
  /** `S`, x-only lowercase hex. */
  redeemKey: string
  url: string
  platform: OnlineShopPlatform
  /** The `X-Imani-Terminal-Enrolment` value for the mint request. */
  enrolmentProof: string
}

export const SHOP_ENROL_MESSAGES: Record<ShopEnrolRefusal, string> = {
  'not-a-shop-code': "That is not an online shop's code. In your shop's Imani settings, copy the stall enrolment code.",
  'bad-url': "The shop's address in that code is not an https address. Check the shop's settings.",
  'bad-platform': 'That shop platform is not supported yet.',
  'bad-signature': "That shop code does not check out. Copy it from the shop's settings again.",
  expired: "That shop code is out of date. Make a new one in the shop's settings.",
}

/** Build a shop's code. The plugin's side, here so both ends share one format (and for tests). */
export function signShopEnrolCode(
  privkey: Uint8Array,
  redeemKey: string,
  url: string,
  platform: OnlineShopPlatform,
  createdAt: number,
): string {
  // `imani-terminal-key:1:<K>:<created_at>:<sig>`: reuse the till's signer, take its last two fields.
  const [, , , at, sig] = signEnrolmentCode(privkey, redeemKey, createdAt).split(':')
  return `${SHOP_ENROL_PREFIX}${redeemKey.toLowerCase()}:${url}:${platform}:${at}:${sig}`
}

/** Read a pasted or scanned shop code. Fail-closed, like `parseOnlineShop`. */
export function readShopEnrolCode(
  text: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ShopEnrolment | ShopEnrolRefusal {
  const raw = text.trim()
  if (!raw.toLowerCase().startsWith(SHOP_ENROL_PREFIX)) return 'not-a-shop-code'
  const rest = raw.slice(SHOP_ENROL_PREFIX.length)
  const key = rest.slice(0, 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(key) || rest[64] !== ':') return 'not-a-shop-code'
  const fields = rest.slice(65).split(':')
  if (fields.length < 4) return 'not-a-shop-code'
  const sig = fields.pop()!.toLowerCase()
  const at = fields.pop()!
  const platform = fields.pop()!
  const url = fields.join(':')
  if (!(ONLINE_SHOP_PLATFORMS as readonly string[]).includes(platform)) return 'bad-platform'
  // The same rules the profile reader applies, so the stall never publishes what wallets refuse.
  if (!parseOnlineShop({ url, redeem_key: key, platform, since: 0 })) return 'bad-url'
  const proof = readEnrolmentCode(`imani-terminal-key:1:${key}:${at}:${sig}`, nowSeconds)
  if (proof === 'not-a-terminal-code') return 'not-a-shop-code'
  if (typeof proof === 'string') return proof
  return { redeemKey: key, url, platform: platform as OnlineShopPlatform, enrolmentProof: enrolmentProofHeader(proof) }
}

/** The profile field for an enrolled shop. */
export function onlineShopOf(enrolment: Pick<ShopEnrolment, 'redeemKey' | 'url' | 'platform'>, sinceSeconds: number): OnlineShop {
  return { url: enrolment.url, redeemKey: enrolment.redeemKey, platform: enrolment.platform, since: sinceSeconds }
}

/** The host shown to the owner ("shop.example"). */
export function shopHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
