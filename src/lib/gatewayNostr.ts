import type { Event } from 'nostr-tools'

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
    const response = await fetch(`${GATEWAY}/api/v1/nostr/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        kinds: [kind],
        authors: [pubkey],
        ...(dTag ? { tags: { '#d': [dTag] } } : {}),
        limit: 500,
      }),
    })
    if (!response.ok) return []

    const body = (await response.json()) as { events?: GatewayEvent[] }
    return (body.events ?? []).map(toEvent).filter((e): e is Event => e !== null)
  } catch {
    return []
  }
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
