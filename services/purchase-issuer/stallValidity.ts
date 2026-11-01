/**
 * How long a stall's coupons live, read from the stall's own signed public record (imani-wallet#312).
 *
 * Card coupons used to be minted for a hard-coded 365 days. The stall's term lives on its public
 * merchant record (kind 30078, `d=imani:merchant`, `voucherValidityDays`), the same record the
 * wallet's Sell screen reads, so a card coupon now carries the term an over-the-counter one would.
 *
 * ## Where it is read from
 *
 * The gateway's public `POST /api/v1/nostr/query` (`permitAll` in gateway-core, the read the
 * wallet's `gatewayEvents` already makes). Not the relay: this image has no WebSocket client and
 * says so in its Dockerfile, and the gateway cache is one of the two stores the wallet itself
 * reads (`newestAddressable`, DEV-144).
 *
 * ## What is trusted
 *
 * Only events that are (a) kind 30078 with exactly the `imani:merchant` `d` tag, (b) authored by
 * the stall, and (c) carry a BIP-340 signature that verifies. Anyone can publish a kind-30078
 * claiming any `pubkey`; the gateway cache is not evidence of authorship. Of those, the NEWEST
 * wins, as a parameterised-replaceable event is replaced.
 *
 * ## What "no answer" means
 *
 * Two different things, kept apart because they need different treatment:
 *
 * - The gateway answered and the stall has no signed record, or its record has no valid term:
 *   that is the stall's DEFAULT, `DEFAULT_VALIDITY_DAYS` (never expires), exactly what the Sell
 *   screen would do for the same stall (`merchant.ts` `emptyMerchant` + `mergeMerchantEvent`).
 * - The gateway could not be asked: `unreadable`. Nothing was learned, and nothing is minted on a
 *   guess. The debt stays OWED and the next pass asks again (see `discharge.ts`).
 *
 * ## Cache
 *
 * A short one (`VALIDITY_CACHE_MS`, two minutes), per stall, of SUCCESSFUL reads only, so a burst
 * of sales costs one query and a stall that changes its term sees it on a sale a few minutes
 * later. Failures are not cached: the next sale asks again.
 */

import { verifyEvent, type Event } from 'nostr-tools/pure'
import { MERCHANT_D_TAG, MERCHANT_KIND, validityFromRecord } from '@imani/merchant-record'

/** The gateway's public event query. Mirrors `gatewayEvents` in `src/lib/gatewayNostr.ts`. */
export const NOSTR_QUERY_PATH = '/api/v1/nostr/query'

/** How long one stall's term is remembered. Minutes, so a changed setting lands soon. */
export const VALIDITY_CACHE_MS = 2 * 60_000

/** How long one read may take. A sale is not held up longer than this. */
export const VALIDITY_TIMEOUT_MS = 5_000

export type StallValidity =
  /** Days, or `NEVER_EXPIRES` (0). Read from the stall's signed record, or its default. */
  | { kind: 'days'; days: number; source: 'record' | 'default' }
  /** The gateway could not be asked or answered nonsense. Nothing learned. */
  | { kind: 'unreadable'; reason: string }

export type ValidityReader = (stallPubkey: string) => Promise<StallValidity>

interface RawEvent {
  id?: unknown
  kind?: unknown
  pubkey?: unknown
  content?: unknown
  tags?: unknown
  createdAt?: unknown
  created_at?: unknown
  sig?: unknown
}

/** A gateway event in nostr-tools' shape, or null when it cannot be one. */
function toEvent(raw: RawEvent): Event | null {
  const created_at = raw.created_at ?? raw.createdAt
  if (
    typeof raw.id !== 'string' ||
    typeof raw.pubkey !== 'string' ||
    typeof raw.sig !== 'string' ||
    typeof raw.content !== 'string' ||
    typeof raw.kind !== 'number' ||
    typeof created_at !== 'number' ||
    !Array.isArray(raw.tags)
  ) {
    return null
  }
  return {
    id: raw.id,
    kind: raw.kind,
    pubkey: raw.pubkey,
    content: raw.content,
    tags: raw.tags as string[][],
    created_at,
    sig: raw.sig,
  }
}

/** Is this event the stall's own, signed, merchant record? */
export function isStallMerchantRecord(event: Event, stallPubkey: string): boolean {
  if (event.kind !== MERCHANT_KIND) return false
  if (event.pubkey.toLowerCase() !== stallPubkey.toLowerCase()) return false
  const dTags = event.tags.filter((t) => Array.isArray(t) && t[0] === 'd')
  if (dTags.length !== 1 || dTags[0][1] !== MERCHANT_D_TAG) return false
  try {
    // A fresh object: nostr-tools caches a verdict on the event it verifies (see audit.ts).
    return verifyEvent({ ...event })
  } catch {
    return false
  }
}

/**
 * The stall's term, from a list of candidate events: the newest one the stall signed, or the
 * default when there is none. Pure, so the trust rules are tested without a gateway.
 */
export function validityFromEvents(events: Event[], stallPubkey: string): StallValidity {
  const newest = events
    .filter((e) => isStallMerchantRecord(e, stallPubkey))
    .sort((a, b) => b.created_at - a.created_at)[0]
  if (!newest) return { kind: 'days', days: validityFromRecord('{}'), source: 'default' }
  return { kind: 'days', days: validityFromRecord(newest.content), source: 'record' }
}

/** Ask the gateway, once, with no cache. */
export async function readStallValidity(
  gatewayUrl: string,
  stallPubkey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = VALIDITY_TIMEOUT_MS,
): Promise<StallValidity> {
  const stall = stallPubkey.toLowerCase()
  try {
    const response = await fetchImpl(`${gatewayUrl.replace(/\/$/, '')}${NOSTR_QUERY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kinds: [MERCHANT_KIND],
        authors: [stall],
        tags: { '#d': [MERCHANT_D_TAG] },
        limit: 50,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { kind: 'unreadable', reason: `merchant record query answered ${response.status}` }
    const body = (await response.json()) as { events?: unknown }
    if (!body || typeof body !== 'object' || !Array.isArray(body.events)) {
      return { kind: 'unreadable', reason: 'merchant record query answered no event list' }
    }
    const events = (body.events as RawEvent[])
      .map((raw) => (raw && typeof raw === 'object' ? toEvent(raw) : null))
      .filter((e): e is Event => e !== null)
    return validityFromEvents(events, stall)
  } catch (error) {
    return { kind: 'unreadable', reason: `merchant record unreachable: ${error instanceof Error ? error.message : 'error'}` }
  }
}

/**
 * A reader with a short per-stall cache of successful answers. `now` is injectable so the expiry
 * is tested without waiting.
 */
export function cachedValidityReader(
  read: ValidityReader,
  now: () => number = () => Date.now(),
  ttlMs = VALIDITY_CACHE_MS,
): ValidityReader {
  const cache = new Map<string, { at: number; value: StallValidity }>()
  return async (stallPubkey) => {
    const key = stallPubkey.toLowerCase()
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.value
    const value = await read(key)
    if (value.kind === 'days') cache.set(key, { at: now(), value })
    else cache.delete(key)
    return value
  }
}
