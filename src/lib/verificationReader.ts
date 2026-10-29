import { verifyEvent, type Event } from 'nostr-tools'
import { badgeOf, type LicenceGrant, type TierCatalog } from '@imani/licence'

import { currentCatalog } from './entitlement'
import { licenceSellerPubkey, licenceStatus } from './licenceStatus'
import { newestAddressable } from './relay'
import {
  BADGES,
  parseVerification,
  VERIFICATION_KIND,
  verificationD,
  type Badge,
  type BadgeWindow,
} from './verificationBadge'
import { walletIsOpen } from './wallet'

/**
 * Which verification badge a key has earned, as a list of windows (#418).
 *
 * Two sources, for two kinds of viewer:
 *
 * - **Anyone looking at a stall** reads the seller's public attestation (`verificationBadge.ts`).
 *   Its signature is checked HERE, and its author must be the pinned seller
 *   (`VITE_LICENCE_SELLER_PUBKEY`): the gateway's cache does not check signatures, and a stall
 *   could publish its own event under the same `d` tag. A build with no seller pinned shows no
 *   badges at all, rather than trusting whoever published one.
 * - **A stall looking at itself** also reads the licences it holds, verified as `licenceStatus`
 *   does, so its own badge is right offline and the moment a plan arrives, before the service has
 *   published anything. Only licences VERIFIED NOW count: the grace window is for selling through
 *   an outage and does not extend a badge.
 *
 * The two are merged; the highest badge in force wins.
 */

/** Cached per key for the session. A miss is retried after this long, a hit kept for longer. */
const MISS_TTL_MS = 60_000
const HIT_TTL_MS = 10 * 60_000

interface Cached {
  at: number
  ttl: number
  windows: Promise<BadgeWindow[]>
}
const cache = new Map<string, Cached>()

export const VERIFICATION_CHANGED_EVENT = 'imani:verification-changed'

/** The signed-in account, so its own avatar also reads the licences it holds. */
let owner: string | undefined

/** Set (or clear) the signed-in account. Called once the wallet is open, and on logout. */
export function setVerificationOwner(pubkey: string | undefined): void {
  owner = pubkey?.toLowerCase()
  refreshOwnBadge()
}

export function verificationOwner(): string | undefined {
  return owner
}

/** Forget every cached answer, and tell mounted badges to ask again. */
export function refreshVerificationBadges(): void {
  cache.clear()
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(VERIFICATION_CHANGED_EVENT))
}

/**
 * Forget only the signed-in account's answer: a licence arrived, or the wallet changed. Cheap, so it
 * can run on every wallet write without re-reading every other avatar on screen from the relay.
 */
export function refreshOwnBadge(): void {
  for (const key of [...cache.keys()]) if (key.startsWith('own:')) cache.delete(key)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(VERIFICATION_CHANGED_EVENT, { detail: { pubkey: owner } }))
  }
}

export interface ReaderDeps {
  seller?: string
  fetchNewest?: (author: string, kind: number, d: string) => Promise<Event | null>
  verify?: (event: Event) => boolean
}

/**
 * The seller's attestation for one stall, verified. Empty when there is none, it is not the
 * seller's, it does not verify, or it cannot be read. NEVER THROWS.
 */
export async function attestedWindows(stallPubkey: string, deps: ReaderDeps = {}): Promise<BadgeWindow[]> {
  const seller = (deps.seller ?? licenceSellerPubkey()).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(seller)) return []
  const fetchNewest = deps.fetchNewest ?? ((author, kind, d) => newestAddressable(author, kind, d))
  const verify = deps.verify ?? ((e: Event) => verifyEvent(e))
  try {
    const event = await fetchNewest(seller, VERIFICATION_KIND, verificationD(stallPubkey))
    if (!event) return []
    if (event.pubkey.toLowerCase() !== seller) return []
    if (event.kind !== VERIFICATION_KIND) return []
    if (!event.tags.some(([n, v]) => n === 'd' && v === verificationD(stallPubkey))) return []
    // A FRESH object: nostr-tools caches a verdict on the event under a symbol, which a spread copies,
    // so a verified event with its content swapped afterwards would pass on the cached answer.
    const { id, pubkey, created_at, kind, tags, content, sig } = event
    if (!verify({ id, pubkey, created_at, kind, tags, content, sig })) return []
    return parseVerification(event.content, stallPubkey) ?? []
  } catch {
    return []
  }
}

/** Windows from licence grants this device verified just now, through the catalog. */
export function grantWindows(grants: readonly LicenceGrant[], catalog: TierCatalog): BadgeWindow[] {
  const out: BadgeWindow[] = []
  for (const g of grants) {
    const badge = badgeOf(g, catalog)
    if (!badge) continue
    out.push({ badge, validFrom: g.validFrom ?? 0, validTo: g.expiresAt })
  }
  return out
}

/** The badge windows this device's own licences earn, verified now. Empty on any failure. */
async function ownWindows(pubkey: string): Promise<BadgeWindow[]> {
  if (!walletIsOpen()) return []
  try {
    const status = await licenceStatus({ pubkey })
    // A decision carried by the grace window verified nothing just now, so it earns no badge.
    if (status.decision.granted && status.decision.source === 'grace') return []
    return grantWindows(status.grants ?? [], currentCatalog())
  } catch {
    return []
  }
}

/** Every badge window known for this key: its public attestation, plus its own licences if it is us. */
export function badgeWindows(pubkey: string, ownPubkey: string | undefined = owner): Promise<BadgeWindow[]> {
  const key = pubkey.toLowerCase()
  const own = ownPubkey !== undefined && ownPubkey.toLowerCase() === key
  const cacheKey = own ? `own:${key}` : key
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.windows

  const windows = Promise.all([attestedWindows(key), own ? ownWindows(key) : Promise.resolve([])]).then(
    ([attested, mine]) => [...attested, ...mine],
  )
  const entry: Cached = { at: Date.now(), ttl: MISS_TTL_MS, windows }
  cache.set(cacheKey, entry)
  void windows.then((w) => {
    entry.ttl = w.length > 0 ? HIT_TTL_MS : MISS_TTL_MS
  })
  return windows
}

export type { Badge }
export { BADGES }
