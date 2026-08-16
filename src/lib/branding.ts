import type { MerchantBranding } from './pass'
import { EMPTY_BRANDING } from './pass'
import { allEvents } from './relay'

/**
 * Merchant branding for a farmer's pass, from their Nostr identity.
 *
 * cashu-voucher's `MerchantBranding` javadoc names its source exactly:
 * `organizationName` is kind-0 `name`, `logoUrl` is kind-0 `picture`,
 * `bannerUrl` is kind-0 `banner`, served by `GET /api/v1/merchant/bootstrap`.
 *
 * **That endpoint does not exist on this stack.** Probed live: 404 on
 * account-app and customer-wallet, 403 on gateway-portal. It ships in
 * imani-bridge and imani-merchant, neither of which is in the running compose.
 * So we read the same kind-0 event the endpoint would have read, through the
 * gateway's nostrdb — the query the wallet already uses for every gift wrap.
 * Same data, no new backend surface.
 *
 * Colours are not in kind-0 and so are never set here; a pass falls back to
 * `VoucherPassMapper`'s dark default. Real branding colours would need the
 * bootstrap endpoint.
 */

/**
 * Same-origin, no prefix: `/api/v1/...` reaches customer-wallet through the
 * proxy rule that already routes `/api`.
 *
 * This was `/customer`, a second prefix that existed only so the dev proxy could
 * strip it. Reproducing that at the edge means a capture-into-variable rewrite,
 * and the obvious form of it silently drops the query string — which is where
 * dm-poll's subscription filter lives. One prefix, one rule, no rewrite.
 */
const GATEWAY = ''

interface RawEvent {
  kind?: number
  pubkey?: string
  content?: string
  createdAt?: number
  created_at?: number
}

/**
 * kind-0 content is a JSON string inside a JSON event — the standard NIP-01
 * shape. Everything in it is optional and user-authored, so nothing here may
 * assume a field exists or that the content parses at all.
 */
interface Kind0Content {
  name?: unknown
  display_name?: unknown
  nip05?: unknown
  picture?: unknown
  banner?: unknown
  about?: unknown
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * An image URL we are willing to load, or nothing.
 *
 * These come from a kind-0 the ISSUER publishes about themselves, so the wallet
 * is fetching a URL a third party chose, from a host they may control. That is a
 * beacon: it hands them the customer's IP and the moment they opened their
 * wallet. There is no CSP on this app to fall back on.
 *
 * https and data only. That drops `http:` (blocked as mixed content on a secure
 * page anyway) and anything exotic, and it is a scheme allow-list rather than a
 * deny-list so an unanticipated scheme fails closed. It does NOT stop the beacon
 * — only a proxy or a CSP would — which is why the render side also sends no
 * referrer.
 */
/**
 * Hosts where http is not a downgrade, because the request never leaves the
 * machine. `[::1]` keeps its brackets — that is what `URL.hostname` returns for
 * an IPv6 literal.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function imageUrl(value: unknown): string | undefined {
  const raw = str(value)
  if (!raw) return undefined
  try {
    // No base URL, deliberately. With one, every relative string resolves
    // against it and comes back https — so "//evil.test/x" and even
    // "definitely not a url" were accepted, which the tests caught. Parsed
    // bare, only an absolute URL succeeds and everything else throws.
    const parsed = new URL(raw)
    if (parsed.protocol === 'https:' || parsed.protocol === 'data:') return raw

    // Loopback http, the same carve-out the web platform makes for Secure
    // Contexts and the same one @imani/blossom-upload makes on the way IN.
    // Without it the two guards disagree: the wallet uploads an avatar to the
    // local Blossom server happily, writes http://localhost:28089/<hash>.webp
    // into the user's kind-0, and then refuses to read it back — so the picture
    // and banner vanish on the next login, when the wiped device has no local
    // copy left to fall back to. Matched on the parsed hostname, so
    // "http://localhost.evil.test" is still rejected.
    //
    // These strings remain attacker-controllable (anyone can publish a kind-0
    // claiming to be you), and this does widen what such a kind-0 can point an
    // <img> at: a loopback port on the reader's own machine. That is a probe of
    // what is listening, not a read — the page cannot see the response bytes —
    // and it is the same class of thing an https URL to any host already allows.
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
      ? raw
      : undefined
  } catch {
    return undefined
  }
}

/** Exported for tests: the mapping from kind-0 content onto MerchantBranding. */
export function brandingFromKind0(content: string): MerchantBranding {
  let parsed: Kind0Content
  try {
    parsed = JSON.parse(content) as Kind0Content
  } catch {
    // A profile we cannot parse is not an error worth surfacing — the pass has
    // a complete set of defaults and renders fine without it.
    return EMPTY_BRANDING
  }
  if (parsed === null || typeof parsed !== 'object') return EMPTY_BRANDING

  return {
    // `display_name` is the friendlier of the two when both are set, but `name`
    // is what MerchantBranding's javadoc names, so it wins.
    organizationName: str(parsed.name) ?? str(parsed.display_name),
    // Taken verbatim and NOT verified against the domain — see MerchantBranding.
    nip05: str(parsed.nip05),
    logoUrl: imageUrl(parsed.picture),
    bannerUrl: imageUrl(parsed.banner),
    storeDescription: str(parsed.about),
  }
}

/**
 * One profile per pubkey per session.
 *
 * A farmer's kind-0 does not change while someone looks at their coupons, and
 * the pass renders on two screens plus every coupon under them — refetching per
 * render would put a request behind each card.
 */
const cache = new Map<string, Promise<MerchantBranding>>()

/**
 * The newest kind-0 content for a pubkey, or null.
 *
 * Shared with lib/profile.ts, which reads the current user's own metadata from
 * the same place. It is extracted rather than copied because the two gotchas
 * below are easy to get wrong twice and impossible to notice when you do: a
 * second implementation reading only `created_at` would silently pick an
 * arbitrary event instead of the latest.
 *
 * Uncached deliberately — `merchantBranding` caches per session, but the profile
 * editor needs to see a save it just made.
 *
 * THE GATEWAY IS ASKED FIRST, THE RELAY SECOND. The gateway's nostrdb cache is
 * the cheap read and usually has the event, but it is not where this wallet
 * WRITES — profiles are published straight to the relay (lib/relay.ts), so a
 * cache that is lagging, cold for a pubkey it has never seen, or unauthenticated
 * for this request answers "no such profile" about a profile that plainly
 * exists. That is how a user came back from a login to a blank avatar and no
 * display name, and how a farmer's coupons rendered under a truncated pubkey and
 * "Gift Card". `newestAddressable` already refuses the cache for exactly this
 * reason; this is the same argument applied to kind 0.
 */
export async function fetchNewestKind0(
  pubkey: string,
): Promise<{ content: string; createdAt: number } | null> {
  const cached = await gatewayKind0(pubkey).catch(() => null)
  if (cached) return cached

  try {
    // Sort rather than trust order — querySync merges replies from several
    // relays. kind 0 is replaceable, but relays are not obliged to have dropped
    // the copy they replaced.
    const newest = (await allEvents(pubkey, 0)).sort((a, b) => b.created_at - a.created_at)[0]
    return newest ? { content: newest.content, createdAt: newest.created_at } : null
  } catch {
    // Both stores unreachable. Callers all have a defensible fallback — the
    // stored profile, or the pass defaults — and none of them should throw at a
    // user over an avatar.
    return null
  }
}

async function gatewayKind0(
  pubkey: string,
): Promise<{ content: string; createdAt: number } | null> {
  const response = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ kinds: [0], authors: [pubkey], limit: 10 }),
  })
  if (!response.ok) return null

  const body = (await response.json()) as { events?: RawEvent[] }
  const events = body.events ?? []
  if (events.length === 0) return null

  // Newest wins. The gateway serialises the timestamp as `createdAt`, not the
  // Nostr-standard `created_at` — the same camelCase divergence the gift-wrap
  // path hits, so read both rather than trusting one.
  const at = (e: RawEvent) => e.createdAt ?? e.created_at ?? 0
  const newest = events.reduce((best, e) => (at(e) > at(best) ? e : best))

  // The timestamp travels with the content because callers need it to decide
  // whether this event is newer than what they already have. It is not
  // decoration: this endpoint reads the GATEWAY'S nostrdb cache, while the
  // wallet publishes straight to the relay (lib/relay.ts). The two are not the
  // same store and the cache can lag indefinitely, so a fetch here may return an
  // event older than one we published seconds ago.
  return typeof newest.content === 'string'
    ? { content: newest.content, createdAt: at(newest) }
    : null
}

async function fetchBranding(pubkey: string): Promise<MerchantBranding> {
  try {
    const newest = await fetchNewestKind0(pubkey)
    return newest === null ? EMPTY_BRANDING : brandingFromKind0(newest.content)
  } catch {
    // Branding is decoration. A farmer whose profile cannot be fetched still has
    // coupons worth showing, so this never propagates.
    return EMPTY_BRANDING
  }
}

/** Branding for one issuer. Never rejects — falls back to the pass defaults. */
export function merchantBranding(pubkey: string): Promise<MerchantBranding> {
  const key = pubkey.toLowerCase()
  let pending = cache.get(key)
  if (!pending) {
    // FAILURES ARE NOT CACHED, only answers. The cache exists so a farmer's
    // kind-0 is fetched once instead of once per card, and that argument holds
    // for a profile that was found. An empty result is the opposite: it means
    // the lookup lost a race with login, or both stores were briefly
    // unreachable, and caching it pins "no such farmer" for the life of the
    // document. That is what left coupons rendering under a truncated pubkey
    // and "Gift Card" until the user reloaded — with the name sitting on the
    // relay the whole time. Dropping the entry costs one refetch on the next
    // render and lets the farmer appear.
    pending = fetchBranding(key).then((branding) => {
      if (branding === EMPTY_BRANDING) cache.delete(key)
      return branding
    })
    cache.set(key, pending)
  }
  return pending
}

/** Exported for tests, which must not share a cache between cases. */
export function clearBrandingCache(): void {
  cache.clear()
}
