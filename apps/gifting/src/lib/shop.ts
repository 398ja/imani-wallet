/**
 * Loading a shop for `/shop/<handle>`, failing closed (ADR 0012, #410 §1).
 *
 * Every dependency is injected so the edge-case table can be tested without a relay: the handle
 * is resolved to a pubkey, the stall's public record and kind-0 are read, and only a live record
 * that says `acceptsCards: true` gets a form. payment-adapter still has the last word when the
 * draft is created.
 */
import type { MerchantProfile } from '@wallet/lib/merchant'

import { parseShopHandle } from './handle'

export interface ShopBranding {
  name?: string
  picture?: string
  about?: string
}

export interface ShopDeps {
  /** `GET /api/v1/resolve/{nip05}` → hex pubkey, or null. Throws only when the service is unreachable. */
  resolve(nip05: string): Promise<string | null>
  /** The stall's kind-30078 `imani:merchant`, or null when there is none (or the relay failed). */
  record(pubkey: string): Promise<MerchantProfile | null>
  /** The kind-0 profile, best effort. */
  branding(pubkey: string): Promise<ShopBranding>
}

export interface Shop {
  nip05: string
  canonical: string
  pubkey: string
  record: MerchantProfile
  branding: ShopBranding
  /** The name to put in sentences; never a key. */
  name: string
}

export type ShopState =
  | { kind: 'invalid' }
  | { kind: 'redirect'; to: string }
  | { kind: 'not-found'; retryable: boolean }
  | { kind: 'paused'; shop: Shop }
  | { kind: 'no-cards'; shop: Shop }
  | { kind: 'ok'; shop: Shop }

export const SHOP_COPY = {
  invalid: "This link isn't a valid shop link.",
  notFound: "We couldn't find this shop.",
  paused: (name: string) => `${name} isn't selling vouchers right now.`,
  noCards: (name: string) =>
    `${name} doesn't take card payments online yet. You can still buy vouchers from them in person.`,
} as const

export async function loadShop(raw: string | undefined, deps: ShopDeps): Promise<ShopState> {
  const handle = parseShopHandle(raw)
  if (handle.kind === 'invalid') return { kind: 'invalid' }
  if (handle.redirect) return { kind: 'redirect', to: `/shop/${handle.canonical}` }

  let pubkey: string | null
  try {
    pubkey = await deps.resolve(handle.nip05)
  } catch {
    // One message for "doesn't exist" and "couldn't ask", with a retry for the latter (§Edge cases).
    return { kind: 'not-found', retryable: true }
  }
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return { kind: 'not-found', retryable: false }

  const [record, branding] = await Promise.all([
    deps.record(pubkey).catch(() => null),
    deps.branding(pubkey).catch((): ShopBranding => ({})),
  ])
  if (!record) return { kind: 'not-found', retryable: true }

  const shop: Shop = {
    nip05: handle.nip05,
    canonical: handle.canonical,
    pubkey,
    record,
    branding,
    name: branding.name?.trim() || handle.nip05,
  }
  if (!record.active) return { kind: 'paused', shop }
  // Only a literal true counts (ADR 0012).
  if (record.acceptsCards !== true) return { kind: 'no-cards', shop }
  return { kind: 'ok', shop }
}

/** G1: drop `noindex` only for a stall that published `giftingIndexable: true`. */
export function robotsFor(state: ShopState): 'index' | 'noindex' {
  return state.kind === 'ok' && state.shop.record.giftingIndexable === true ? 'index' : 'noindex'
}
