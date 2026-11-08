import { SimplePool, verifyEvent, type Event } from 'nostr-tools'
import { recordRelayPublish } from './eventSizeTelemetry'
import { GATEWAY_PAGE_LIMIT, gatewayAllEvents, gatewayQuery, GatewayUnreachableError, newestByD } from './gatewayNostr'

/**
 * The wallet's Nostr I/O: WRITES go to the relay, READS go through the cache.
 *
 * OWNER RULE (2026-10-30, #428): the browser never READS from the relay (strfry) directly. Every
 * read goes through the gateway's `POST /api/v1/nostr/query`, which serves nostrdb and merges a
 * live relay query server-side (`CachingNostrGatewayDecorator`), so the answer stays fresh.
 * `relayReadRule.test.ts` fails if a read path opens a socket again.
 *
 * Why: each read used to open its own `SimplePool` to strfry, beside the gateway read it was
 * merged with. On staging (redeploy 60) that was one websocket every ~0.6 s while a gift link was
 * being settled, and each settle paid for the slower of the two stores (#428).
 *
 * The function names (`allEvents`, `allAddressable`, `newestAddressable`, `allEventsWithGateway`)
 * are kept so callers did not change. Their contract is the same, with one improvement: a read the
 * gateway could not answer now THROWS (`GatewayUnreachableError`) instead of resolving `[]`, which
 * a caller could not tell from "no records" (the 2026-10-18 incident). Every caller already catches.
 *
 * Every event a read hands back is checked: right author, right kind, and a signature that
 * verifies. The rows built from these become balances and roles, and the gateway is a cache, not
 * an authority. A FRESH object is verified, so no cached verdict on the input can ride along.
 *
 * Publishing still opens a socket to the relay, because the relay is where this wallet writes.
 *
 * The relay URL is NOT taken from `GET /api/v1/config`. That endpoint reports
 * `wss://relay.imani.local` on this stack, a name that does not resolve from a browser.
 *
 * ponytail: hardcoded dev default, overridable with VITE_RELAY_URL.
 */
// A BROWSER default pointing at localhost, used only when VITE_RELAY_URL is unset at build time
// — i.e. a developer running the dev server. A deployed build always has the variable, and a
// page served over https cannot open a ws:// socket at all: the browser refuses mixed content,
// which is a stronger guarantee than this check.
// nosemgrep: imani-cleartext-relay-default
export const RELAY_URL: string = import.meta.env.VITE_RELAY_URL ?? 'ws://localhost:27778'

/**
 * The same relay, addressed the way the GATEWAY can reach it.
 *
 * Not interchangeable with `RELAY_URL`. That one is browser-reachable
 * (`localhost:27778`, a published port); this one is the docker-DNS name the
 * gateway containers resolve. Anything we ask the gateway to publish on our
 * behalf — the coupon DMs in lib/issue.ts — must carry THIS url, because the
 * gateway does the publishing from inside the compose network where
 * `localhost` is its own container.
 *
 * ponytail: hardcoded dev default like RELAY_URL above, overridable with
 * VITE_INTERNAL_RELAY_URL. Both should come from GET /api/v1/config eventually.
 */
// Same reasoning as RELAY_URL above: a build-time default for the local stack, and mixed-content
// rules stop a deployed page using it.
export const INTERNAL_RELAY_URL: string =
  // nosemgrep: imani-cleartext-relay-default
  import.meta.env.VITE_INTERNAL_RELAY_URL ?? 'ws://nostr-relay:7777'

export interface PublishResult {
  ok: number
  total: number
  /** Reasons the failed relays gave, for a message the user can act on. */
  errors: string[]
}

export { GatewayUnreachableError }

/**
 * Publish a signed event, resolving with a count rather than throwing.
 *
 * A partial publish is the normal case on Nostr, not an error: the event is
 * live as soon as one relay accepts it. Callers report "n/m" and carry on, which
 * is why this never rejects.
 *
 * A relay that REFUSES the event (`OK false`, e.g. strfry's
 * `invalid: event too large: 66031`) is a failure too: nostr-tools rejects that
 * promise with the relay's reason, which lands in `errors` and not in `ok`.
 * Locked by relayPublishCount.test.ts against a real socket. The silence in
 * #203 was a CALLER ignoring this result; every caller must check `ok`.
 */
export async function publish(
  event: Event,
  relays: string[] = [RELAY_URL],
  /** A longer connect window, for a caller that has seen the default lose a race (#402). */
  opts: { connectMs?: number } = {},
): Promise<PublishResult> {
  // #428 WRITE-THROUGH. Reads go only through the gateway now, and for non-addressable kinds it
  // answers from nostrdb alone while its copy is "fresh" (30 min), never asking the relay. An event
  // published only to strfry stayed invisible: on staging a sender's history read 4 of 46 events.
  // So every publish also stores the event in the cache. Best effort, in parallel, never blocks or
  // changes the relay result.
  void cacheEvent(event)
  // Event size telemetry (#532): once per publish call, before sending, whatever the outcome.
  // Synchronous and never throws, so it cannot delay or fail the publish. The cacheEvent mirror
  // above is measured by the gateway, not here.
  try {
    recordRelayPublish(event)
  } catch {
    // telemetry never fails a publish
  }
  const pool = opts.connectMs ? new SimplePool({ maxWaitForConnection: opts.connectMs } as never) : new SimplePool()
  try {
    const results = await Promise.allSettled(pool.publish(relays, event))
    // A relay that could not be REACHED does not reject. nostr-tools (2.24)
    // catches the connection error and resolves with the string
    // "connection failure: ...", so counting fulfilled results counted every
    // unreachable relay as having accepted the event. Measured against
    // ws://127.0.0.1:9 and an unresolvable host: {ok: 1, errors: []}. Callers
    // that record "this is on the relay" on ok > 0 (attestation receipts, the
    // transfer receipt queue) then believed something no relay held.
    const errors = results.flatMap((r) => {
      if (r.status === 'rejected') {
        return [r.reason instanceof Error ? r.reason.message : String(r.reason)]
      }
      return typeof r.value === 'string' && r.value.startsWith('connection failure') ? [r.value] : []
    })

    return { ok: results.length - errors.length, total: results.length, errors }
  } finally {
    // Without this the WebSocket stays open for the life of the page. Each
    // profile save would leak another connection to the same relay.
    pool.close(relays)
  }
}

/**
 * Store a signed event in the gateway's nostrdb (`POST /api/v1/nostr/events`, NIP-98; the gateway
 * re-derives the id and checks the signature). NEVER THROWS. Returns whether it was stored.
 */
export async function cacheEvent(event: Event): Promise<boolean> {
  try {
    const { signedFetch } = await import('./nip98')
    const response = await signedFetch(
      '/api/v1/nostr/events',
      'POST',
      { id: event.id, pubkey: event.pubkey, createdAt: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig },
      undefined,
      { signal: AbortSignal.timeout(8_000) },
    )
    return response.ok
  } catch {
    return false
  }
}

/** Only events by `author`, of `kind`, whose signature verifies. */
function authentic(events: Event[], author: string, kind: number): Event[] {
  const out = new Map<string, Event>()
  for (const event of events) {
    if (out.has(event.id) || event.pubkey !== author || event.kind !== kind) continue
    const { id, pubkey, created_at, tags, content, sig } = event
    if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) continue
    out.set(event.id, event)
  }
  return [...out.values()]
}

/**
 * Every event of one kind for a pubkey, UNDEDUPED by `d`, through the cache.
 *
 * `allAddressable`'s newest-per-`d` rule is the right one for a ledger, where the latest record
 * supersedes. It is the wrong one for coupons, where a "this is spent" tombstone must win over the
 * record of the coupon even if both land in the same second (see `voucherRecords.restoreVouchers`).
 * That reduction needs the raw list.
 *
 * PAGED (#206 review M2, review of #326): the gateway, like strfry, answers the newest 500 per
 * filter and says nothing about the rest, so this walks back with `until`. Throws
 * `GatewayUnreachableError` when the gateway did not answer at all; a later page failing returns
 * what was read (partial is only ever LESS, and every caller treats a missing record as "not
 * confirmed").
 */
export async function allEvents(pubkey: string, kind: number): Promise<Event[]> {
  const events = await gatewayAllEvents(pubkey, kind)
  if (events === null) throw new GatewayUnreachableError('nostr/query did not answer')
  return authentic(events, pubkey, kind)
}

/**
 * #540 F6: the events of one kind for a pubkey whose `d` is one of `dTags`, in ONE gateway query
 * (`#d`, which the gateway honours on the wire). For a lookup of a few known records, where
 * `allEvents` would read the whole kind. Throws `GatewayUnreachableError` when it did not answer.
 */
export async function eventsByD(pubkey: string, kind: number, dTags: string[]): Promise<Event[]> {
  if (dTags.length === 0) return []
  const events = await gatewayQuery({ kinds: [kind], authors: [pubkey], tags: { '#d': dTags }, limit: 500 })
  return authentic(events, pubkey, kind)
}

/**
 * #540 F7: the events of one kind for a pubkey created at or after `since` (unix s), in ONE query.
 * Null when the page came back full (there may be more): the caller does its full read instead.
 * Throws `GatewayUnreachableError` when the gateway did not answer.
 */
export async function eventsSince(pubkey: string, kind: number, since: number): Promise<Event[] | null> {
  const events = await gatewayQuery({ kinds: [kind], authors: [pubkey], since, limit: GATEWAY_PAGE_LIMIT })
  if (events.length >= GATEWAY_PAGE_LIMIT) return null
  return authentic(events, pubkey, kind)
}

/**
 * The same read as `allEvents`. The name is kept from when it merged a relay read with the
 * gateway's (2026-10-18 incident); since #428 every read is the gateway's.
 */
export const allEventsWithGateway = allEvents

/**
 * Every addressable event of one kind whose `d` tag starts with a prefix, newest copy of each.
 *
 * The list counterpart of `newestAddressable`, for records that are one event PER ITEM: issuance
 * records (`imani:issued:<voucherId>`), history rows. Filtered by prefix here, because no store can
 * match a `d` PREFIX on the wire. De-duplicated by `d`, keeping the newest: a store is not obliged
 * to have dropped an older copy, and a re-published record would otherwise restore twice.
 */
export async function allAddressable(pubkey: string, kind: number, dPrefix: string): Promise<Event[]> {
  const matching = (await allEvents(pubkey, kind)).filter((event) =>
    event.tags.some(([name, value]) => name === 'd' && value?.startsWith(dPrefix)),
  )
  return newestByD(matching)
}

/** Most events read at one ledger v2 locator; above it the read throws (matches the Java). */
export const MAX_LEDGER_EVENTS = 4096
/** Most gateway pages one locator read walks; beyond it the read throws (review N5). */
export const MAX_LEDGER_PAGES = Math.ceil(MAX_LEDGER_EVENTS / GATEWAY_PAGE_LIMIT) + 2

/**
 * #310: every event of one kind at a `d` tag, from ANY author, whose own id and signature verify,
 * paged through the gateway to exhaustion (inclusive `until`), never truncated. For voucher ledger v2, whose events are signed by per-voucher keys nobody
 * knows in advance, so there is no author to filter on; the reader trusts the inner signature,
 * never the author. Throws `GatewayUnreachableError` when the gateway did not answer.
 * Also throws above `MAX_LEDGER_EVENTS` events, on a full page within one second, or past
 * `MAX_LEDGER_PAGES` pages.
 */
export async function eventsByDTag(kind: number, d: string): Promise<Event[]> {
  // No truncation (imani-wallet#582): the gateway caps every answer at GATEWAY_PAGE_LIMIT, so walk
  // back with an inclusive `until` until a page brings nothing new. Any page failing throws, and
  // more than MAX_LEDGER_EVENTS at one locator throws: never answer from a partial set.
  const seen = new Map<string, Event>()
  let until: number | undefined
  for (let page = 0; ; page++) {
    if (page >= MAX_LEDGER_PAGES) throw new GatewayUnreachableError(`ledger locator not exhausted in ${MAX_LEDGER_PAGES} pages`)
    const batch = await gatewayQuery({ kinds: [kind], tags: { '#d': [d] }, limit: GATEWAY_PAGE_LIMIT, ...(until === undefined ? {} : { until }) })
    let fresh = 0
    for (const event of batch) {
      if (!seen.has(event.id)) {
        seen.set(event.id, event)
        fresh++
      }
    }
    if (seen.size > MAX_LEDGER_EVENTS) {
      throw new GatewayUnreachableError(`more than ${MAX_LEDGER_EVENTS} events at one ledger locator`)
    }
    if (fresh === 0) {
      // A full page all in one second cannot be walked past without skipping events.
      if (batch.length >= GATEWAY_PAGE_LIMIT) throw new GatewayUnreachableError('ledger locator page cannot be exhausted')
      break
    }
    if (batch.length < GATEWAY_PAGE_LIMIT && until === undefined) break
    until = Math.min(...batch.map((e) => e.created_at))
  }
  const events = [...seen.values()]
  const out = new Map<string, Event>()
  for (const event of events) {
    if (out.has(event.id) || event.kind !== kind) continue
    if (!event.tags.some(([name, value]) => name === 'd' && value === d)) continue
    const { id, pubkey, created_at, tags, content, sig } = event
    if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) continue
    out.set(event.id, event)
  }
  return [...out.values()]
}

/**
 * The newest parameterised-replaceable event (NIP-33) for a pubkey and `d` tag, or null when the
 * gateway holds none. Throws `GatewayUnreachableError` when it did not answer: null here takes away
 * the merchant role, so "unreachable" must never read as "none".
 *
 * `#d` goes on the wire (the gateway honours a standard tag filter, DEV-144) and is checked again
 * here, so a store that ignored it could not satisfy `imani:merchant` with another kind-30078 this
 * key has published.
 */
export async function newestAddressable(pubkey: string, kind: number, d: string): Promise<Event | null> {
  const events = await gatewayQuery({ kinds: [kind], authors: [pubkey], tags: { '#d': [d] }, limit: 50 })
  return (
    authentic(events, pubkey, kind)
      .filter((e) => e.tags.some(([name, value]) => name === 'd' && value === d))
      .sort((a, b) => b.created_at - a.created_at)[0] ?? null
  )
}
