import { verifyEvent, type Event } from 'nostr-tools'

/**
 * Reading Nostr events through the GATEWAY rather than from the browser.
 *
 * NOT "the gateway's nostrdb cache", which is what an earlier version of this
 * comment said. For kind-30078 the answer comes from the gateway's own
 * SERVER-SIDE RELAY CONNECTION, not from its cache: `RelayIngestPump`
 * subscribes to kind-1059 only, so this kind never enters nostrdb by that
 * route, and yet the endpoint returns it. Measured — see the verdicts below.
 *
 * The distinction matters. What this module actually buys is a SERVER that can
 * reach the relay when the browser cannot, and `CachingNostrGatewayDecorator`
 * always merges a live relay query, so the answer is fresh rather than stale.
 * Describing it as a cache read invites the assumption that it lags, and the
 * measurement says otherwise.
 *
 * The counterpart to `lib/relay.ts`, which reads the same events straight from
 * strfry. Both exist because neither is sufficient alone, and DEV-144 is the
 * record of what happens when only one is used:
 *
 * - **The relay alone** needs strfry reachable FROM THE BROWSER. This dev stack
 *   publishes its port, but `imani-deploy/docker-compose.test.yml` deliberately
 *   publishes none — "services reach via docker DNS only". In a deployment that
 *   does not expose the relay, a merchant's stall record and their whole
 *   issuance ledger become unreadable: the merchant home reverts to a customer
 *   view and Stats resets to zero. Since logout wipes the device, that is the
 *   only path back to a merchant's own books.
 * - **The gateway alone** is not where this wallet WRITES. Merchant records are
 *   published straight to the relay, and the gateway's ingest pump subscribes
 *   to kind-1059 gift wraps only (`RelayIngestPump.KIND_GIFT_WRAP`), so a
 *   kind-30078 written by this wallet may never enter its nostrdb by that
 *   route at all.
 *
 * So: ASK BOTH, NEWEST WINS. Exactly the rule `fetchNewestKind0` already
 * applies to profiles, for the same reason and after the same bug.
 *
 * ## Why this is safe now, and was not when DEV-144 was written
 *
 * The card listed five defects. Each verdict below is marked MEASURED (I ran
 * it against staging) or READ (I read the source or trusted another card), so
 * a future reader knows which claims carry evidence and which carry an
 * argument. The distinction cost a debugging round on this very card, where
 * the whole bypass rested on a source-reading that had gone stale.
 *
 * 1. **Tag filters were ignored.** The DTO read its own `pTags` field, so `#d`
 *    was a suggestion and the gateway returned everything it had. FIXED:
 *    `NostrQueryRequest` now carries a general `tags` map, and `effectiveTags()`
 *    merges `pTags` into it as `#p`. `NostrQueryAdapter` applies it both on the
 *    wire (`buildRelayFilter`) and again locally (`matchesFilters`), so a `#d`
 *    filter is now a filter. **MEASURED**: unfiltered kind-30078 returns 104
 *    events; the same query with `tags:{"#d":[one]}` returns 1.
 * 2. **`#p` matched nothing in nostrdb.** Tag values were stored as binary ids
 *    and queried as strings. Reported FIXED in nostrdb-jni 0.2.2 (DEV-226).
 *    **READ**, not measured here — and it does not gate this module, which
 *    filters on `#d` and never on `#p`.
 * 3. **EOSE ended a query before its own events arrived.** FIXED in
 *    wallet-core-nostr 0.1.30-0.1.32 (DEV-225). **READ** — that card carries
 *    its own reproduction; nothing here re-tests it.
 * 4. **The cache could short-circuit the relay.** FIXED: `queryEventsWithCache`
 *    now ALWAYS merges a live relay query — local events "seed the result set
 *    ... but they DO NOT short-circuit the relay query" — and for addressable
 *    kinds it prunes anything the relay did not return, guarded on the relay
 *    having actually answered. **MEASURED**: an event published to the relay
 *    from this machine came back through the gateway 2.5s later, which a
 *    short-circuiting cache could not have returned at all.
 * 5. **The ingest pump can die silently, and its health lies.** NOT FIXED, and
 *    it is why this module supplements the relay rather than replacing it. A
 *    frozen cache costs nothing here: its answer is merged, and a newer relay
 *    copy wins. **READ** — inducing a pump stall was not attempted. Since
 *    kind-30078 is served by the relay leg rather than the cache, a frozen
 *    pump would not affect these reads anyway.
 *
 * The prefix query (`allAddressable`) remains a client-side filter regardless:
 * no relay can match a `d` PREFIX, so neither can the gateway.
 *
 * **The honest summary**: two of the five verdicts are measured, and they are
 * the two this module depends on. The other three are read from source or
 * inherited from sibling cards, and none of them gates this code path.
 */

/** Same-origin. See the note on `GATEWAY` in lib/branding.ts. */
const GATEWAY = ''

/**
 * The gateway's JSON shape, which is NOT quite a Nostr event.
 *
 * `createdAt` rather than the standard `created_at` — the same camelCase
 * divergence `gatewayKind0` and the gift-wrap path both hit. Read both and
 * prefer neither, because which one arrives depends on the serialiser.
 */
interface GatewayEvent {
  id?: string
  kind?: number
  pubkey?: string
  content?: string
  tags?: string[][]
  createdAt?: number
  created_at?: number
  sig?: string
}

function toEvent(raw: GatewayEvent): Event | null {
  // An event with no id or no timestamp cannot be deduped or compared, and
  // every caller does both. Dropping it is better than admitting a shape the
  // merge rules cannot reason about.
  const created_at = raw.createdAt ?? raw.created_at
  if (!raw.id || typeof created_at !== 'number') return null
  return {
    id: raw.id,
    kind: raw.kind ?? 0,
    pubkey: raw.pubkey ?? '',
    content: raw.content ?? '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    created_at,
    sig: raw.sig ?? '',
  }
}

/**
 * Events of one kind for one author, from the gateway's cache. NEVER THROWS.
 *
 * Returns an empty list on any failure — an unreachable gateway, a 401, a
 * frozen cache. Every caller merges this with a relay read, so "nothing here"
 * must be indistinguishable from "not asked", and neither may break the caller.
 *
 * `dTag` goes on the wire as a standard `#d` filter, which the gateway now
 * honours (see the header). Omitted for a prefix query, where no filter can
 * express what is wanted and the caller filters locally anyway.
 */
export async function gatewayEvents(
  pubkey: string,
  kind: number,
  dTag?: string,
): Promise<Event[]> {
  try {
    return await gatewayQuery({
      kinds: [kind],
      authors: [pubkey],
      ...(dTag ? { tags: { '#d': [dTag] } } : {}),
      limit: 500,
    })
  } catch {
    return []
  }
}

/** The gateway did not answer a read (unreachable, timed out, or not a 2xx). */
export class GatewayUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayUnreachableError'
  }
}

/**
 * One `POST /api/v1/nostr/query`, THROWING `GatewayUnreachableError` when the gateway did not
 * answer, so a caller can tell "unreachable" from "no events". Bounded by
 * `GATEWAY_PAGE_TIMEOUT_MS`. Events are NOT signature-checked here; `relay.ts` does that.
 */
export async function gatewayQuery(filter: Record<string, unknown>): Promise<Event[]> {
  let response: Response
  try {
    response = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: AbortSignal.timeout(GATEWAY_PAGE_TIMEOUT_MS),
      body: JSON.stringify(filter),
    })
  } catch (error) {
    throw new GatewayUnreachableError(error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) throw new GatewayUnreachableError(`nostr/query answered ${response.status}`)
  let body: { events?: GatewayEvent[] }
  try {
    body = (await response.json()) as { events?: GatewayEvent[] }
  } catch (error) {
    throw new GatewayUnreachableError(error instanceof Error ? error.message : String(error))
  }
  return (body.events ?? []).map(toEvent).filter((e): e is Event => e !== null)
}

/** The gateway's page size for `gatewayAllEvents`; it also caps lower reads at 500 upstream. */
export const GATEWAY_PAGE_LIMIT = 500
/** Backstop against a gateway that ignores `until`: 100 pages, the relay walk's own bound. */
const GATEWAY_MAX_PAGES = 100
/** Per page. A gateway that accepts the socket and never answers must not hang a logout. */
export const GATEWAY_PAGE_TIMEOUT_MS = 8_000

/**
 * EVERY event of one kind for one author from the gateway, paged with `until`
 * (review of #326). NEVER THROWS.
 *
 * `gatewayEvents` asks once with `limit: 500`, and the gateway (like strfry)
 * answers the NEWEST 500 and says nothing about the rest. For coupon records
 * that silently dropped a big wallet's OLDEST coupons from the very read that
 * exists for when the relay is unreachable. Same walk as `relay.allEvents`:
 * an inclusive cursor (several events share a second), dedup by id, and a
 * page with nothing new ends it.
 *
 * Returns `null` when the gateway did not answer at all, so a caller can tell
 * "unreachable" from "no events" (the confusion behind the 2026-10-18
 * incident). A later page failing returns what was read: partial is only ever
 * LESS, and every caller treats a missing record as "not confirmed".
 */
export async function gatewayAllEvents(pubkey: string, kind: number): Promise<Event[] | null> {
  const seen = new Map<string, Event>()
  let until: number | undefined
  let answered = false
  for (let page = 0; page < GATEWAY_MAX_PAGES; page++) {
    let batch: Event[]
    try {
      batch = await gatewayQuery({
        kinds: [kind],
        authors: [pubkey],
        limit: GATEWAY_PAGE_LIMIT,
        ...(until === undefined ? {} : { until }),
      })
    } catch {
      break
    }
    answered = true
    let fresh = 0
    for (const event of batch) {
      if (!seen.has(event.id)) {
        seen.set(event.id, event)
        fresh++
      }
    }
    if (batch.length === 0) break
    const oldest = Math.min(...batch.map((e) => e.created_at))
    if (fresh === 0) {
      if (batch.length < GATEWAY_PAGE_LIMIT) break
      // A full page all in one second: step past that second rather than loop.
      until = oldest - 1
      continue
    }
    // A SHORT page is not taken as the end (the gateway may cap below the ask):
    // only a page with nothing new ends the walk.
    until = oldest
  }
  return answered ? [...seen.values()] : null
}

/**
 * Merge two reads of the same query, newest copy of each `d` winning.
 *
 * Deduped by `d` rather than by event id, because that is what "the same
 * record" means for an addressable kind: two stores holding different
 * revisions of one record hold two different ids, and taking both would
 * restore a merchant's stall twice, once stale.
 *
 * Events with no `d` fall back to their id, so nothing is silently dropped.
 */
export function newestByD(...sources: Event[][]): Event[] {
  const newest = new Map<string, Event>()
  for (const events of sources) {
    for (const event of events) {
      const key = event.tags.find(([name]) => name === 'd')?.[1] ?? event.id
      const seen = newest.get(key)
      if (!seen || event.created_at > seen.created_at) newest.set(key, event)
    }
  }
  return [...newest.values()]
}

/**
 * The relay's events plus the gateway's, as a raw union by event id: no
 * newest-per-`d` reduction, because coupon records need every event (see
 * `relay.allEventsWithGateway`).
 *
 * A gateway event joins only if it is by `author`, of `kind`, and its signature
 * verifies. The rows built from these become a balance, and the gateway is a
 * second source, not a trusted one. Events arrive as JSON, so no cached
 * verification verdict can ride along (see `audit.stripCachedVerdict`); the
 * copy below makes sure of it for in-memory callers too.
 */
export function unionWithGateway(
  relayed: Event[],
  cached: Event[],
  author: string,
  kind: number,
): Event[] {
  const byId = new Map<string, Event>()
  for (const event of relayed) byId.set(event.id, event)
  for (const event of cached) {
    if (byId.has(event.id)) continue
    if (event.pubkey !== author || event.kind !== kind) continue
    const { id, pubkey, created_at, tags, content, sig } = event
    if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) continue
    byId.set(event.id, event)
  }
  return [...byId.values()]
}
