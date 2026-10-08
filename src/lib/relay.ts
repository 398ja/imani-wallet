import { SimplePool, type Event } from 'nostr-tools'
import { gatewayEvents, newestByD } from './gatewayNostr'

/**
 * Publishing to the Nostr relay.
 *
 * Reads go to BOTH this relay and the gateway's nostrdb cache, newest winning
 * (see lib/gatewayNostr.ts). WRITES go straight to the relay from the browser.
 *
 * That write path is why deploy/compose.override.yml publishes strfry's port at
 * all — upstream's docker-compose.test.yml exposes it only on the internal
 * Docker network. Reads no longer DEPEND on that port being published, which is
 * what DEV-144 was about; publishing an event still does.
 *
 * The relay URL is NOT taken from `GET /api/v1/config`. That endpoint reports
 * `wss://relay.imani.local` on this stack — a name that does not resolve from a
 * browser — and the container-internal `ws://nostr-relay:7777` would not either.
 * Neither is reachable from where this code runs.
 *
 * ponytail: hardcoded dev default, overridable with VITE_RELAY_URL. Read it from
 * the gateway once it reports a browser-reachable URL.
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
 * scripts/seed-merchant.mjs draws the same distinction, for the same reason.
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

/**
 * How long a READ may spend opening a socket to the relay.
 *
 * SimplePool's default is 3000ms, and that number is the wallet's worst
 * latency in its ordinary deployed state rather than in a rare one. Reads go to
 * the relay AND the gateway in parallel and merge the results, so the caller
 * waits for the slower store — and reaching strfry from a browser needs its
 * port published, which `imani-deploy/docker-compose.test.yml` deliberately
 * does not do. Measured against a real strfry and two dead addresses:
 *
 *   healthy relay ..................... 25ms
 *   port not published (refused) ....... 3ms
 *   unroutable host (dropped) ....... 3002ms   <- the default, in full
 *   the same, with this cap at 1200 . 1201ms
 *
 * A refused connection is already fast because the OS answers immediately; the
 * expensive case is a host that DROPS packets — a firewall, a phone whose radio
 * has gone to sleep, a container on an address that no longer routes — where
 * nothing answers and only a timer ends the wait.
 *
 * 1200ms is far above a healthy connect (single-digit ms on a LAN, tens over
 * the internet) and far below the default, so it cannot fail a relay that was
 * going to answer. Deliberately NOT as aggressive as branding.ts' 150ms grace:
 * that one has a second store holding the same answer and a correction path if
 * it guesses wrong. These reads decide whether a merchant HAS a stall at all —
 * `newestAddressable` returning null takes away the merchant role, the home
 * screen and Stats — so the bias here is towards giving the relay its say.
 *
 * PUBLISHING IS NOT CAPPED. A read that gives up early costs a slower answer
 * from the other store; a publish that gives up early is an event the user
 * believes they sent and nobody has.
 */
const READ_CONNECT_TIMEOUT_MS = 1200

/**
 * A pool for reads, with the connection wait bounded.
 *
 * `maxWait` on `querySync` is NOT enough and this was measured, not assumed: it
 * sets the EOSE timeout, so it bounds a relay that connects and then says
 * nothing, while a relay that never connects still burns the full default. Both
 * knobs are needed, and this is the one that fixes the expensive case.
 */
function readPool(): SimplePool {
  /*
    THE CAST IS AN UPSTREAM TYPE GAP, not a lie about the runtime.

    `SimplePool`'s constructor is typed as
    `Pick<AbstractPoolConstructorOptions, 'enablePing' | 'enableReconnect'>`,
    which omits `maxWaitForConnection` — but its body is
    `super({ ..., maxWaitForConnection: 3e3, ...options })`, so an option passed
    here lands AFTER the default and replaces it. The declaration is narrower
    than the implementation.

    Verified by measurement rather than by reading: against a host that drops
    packets, an uncapped pool takes 3002ms and this one 1201ms. If a future
    nostr-tools widens the type, delete the cast and nothing else changes; if it
    ever stops forwarding the option, the probe in `relayTimeouts.test.ts` fails
    rather than the app silently going slow again.
  */
  return new SimplePool({
    maxWaitForConnection: READ_CONNECT_TIMEOUT_MS,
  } as ConstructorParameters<typeof SimplePool>[0])
}

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
export async function publish(event: Event, relays: string[] = [RELAY_URL]): Promise<PublishResult> {
  const pool = new SimplePool()
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
 * The newest parameterised-replaceable event (NIP-33) for a pubkey and `d` tag,
 * read from the relay AND the gateway's cache, newest winning.
 *
 * This read used to refuse the gateway outright. DEV-144 recorded why, and the
 * re-check that closed it found four of those five reasons fixed upstream —
 * see the header of lib/gatewayNostr.ts for the itemised verdict. The one that
 * survives (a cache that can freeze silently) is harmless to a merge, because
 * a stale copy simply loses to the relay's.
 *
 * What the bypass cost was larger than what it avoided: reaching strfry from a
 * browser needs its port published, and a real deployment does not publish it.
 * With the relay unreachable this returned null, and null here means the
 * merchant role disappears — the home screen reverts to a customer's, Stats
 * resets to zero, and since logout wipes the device there is no other way back
 * to a merchant's own books.
 *
 * No `ws` polyfill here, unlike scripts/seed-merchant.mjs — that is a Node 20
 * problem (no global WebSocket, and the failure is silent because the promise
 * inside `publish()` still resolves). Browsers have had WebSocket all along.
 */
/**
 * Every addressable event of one kind whose `d` tag starts with a prefix, newest
 * copy of each.
 *
 * The list counterpart of `newestAddressable`, for records that are one event
 * PER ITEM rather than one event per user — issuance records, whose `d` is
 * `imani:issued:<voucherId>`. Filtering is by prefix and done here rather than
 * on the wire, because a relay cannot match prefixes and a `#d` list would mean
 * knowing every voucher id before asking for it.
 *
 * De-duplicated by `d`, keeping the newest: NIP-33 says a later event replaces
 * an earlier one with the same address, but relays are not obliged to have
 * dropped the old copy, and a re-published record would otherwise restore twice.
 */
export async function allAddressable(
  pubkey: string,
  kind: number,
  dPrefix: string,
  relays: string[] = [RELAY_URL],
): Promise<Event[]> {
  // BOTH STORES (DEV-144). The relay is the wallet's write target and stays
  // authoritative on conflict, but reaching it from a browser needs a published
  // strfry port, which a real deployment does not have — and without this read
  // a merchant loses their entire issuance ledger. The gateway's copy is merged
  // rather than trusted: a frozen cache costs nothing, because a newer relay
  // event wins.
  //
  // No `#d` on the wire here: this is a PREFIX query, which no relay can
  // express, so the filtering below is the only filtering there is either way.
  const [relayed, cached] = await Promise.all([
    allEvents(pubkey, kind, relays).catch(() => []),
    gatewayEvents(pubkey, kind),
  ])

  const matching = (events: Event[]) =>
    events.filter((event) =>
      event.tags.some(([name, value]) => name === 'd' && value?.startsWith(dPrefix)),
    )
  return newestByD(matching(relayed), matching(cached))
}

/**
 * Every event of one kind for a pubkey, UNDEDUPED.
 *
 * `allAddressable`'s newest-per-`d` rule is the right one for a ledger, where
 * the latest record supersedes. It is the wrong one for coupons, where a
 * "this is spent" tombstone must win over the record of the coupon even if
 * both land in the same second and the relay replays them in either order —
 * see `voucherRecords.restoreVouchers`. That reduction needs the raw list.
 */
export async function allEvents(
  pubkey: string,
  kind: number,
  relays: string[] = [RELAY_URL],
): Promise<Event[]> {
  // PAGED (#206 review M2). strfry caps every filter at `maxFilterLimit` (500)
  // newest events and says nothing, so an unpaged read silently loses a wallet's
  // OLDEST records. Walk back with `until`. The cursor is INCLUSIVE (the oldest
  // second seen) because several events share a second (every chunk of a
  // snapshot does) and a page can end inside one; duplicates are dropped by id.
  const pool = readPool()
  const seen = new Map<string, Event>()
  try {
    let until: number | undefined
    for (let page = 0; page < MAX_READ_PAGES; page++) {
      const batch = await pool.querySync(
        relays,
        { authors: [pubkey], kinds: [kind], limit: RELAY_PAGE_LIMIT, ...(until === undefined ? {} : { until }) },
        { maxWait: READ_CONNECT_TIMEOUT_MS },
      )
      let fresh = 0
      for (const event of batch) {
        if (!seen.has(event.id)) {
          seen.set(event.id, event)
          fresh++
        }
      }
      // A SHORT page is not the end: `maxWait` is an EOSE timeout, and a page of
      // 55 KB chunk events can outlast it (measured on strfry: 151 of 500 at
      // 1200ms), so querySync hands back the newest part of a page. Only a page
      // that brings nothing new ends the walk.
      if (batch.length === 0) break
      if (fresh === 0) {
        if (batch.length < RELAY_PAGE_LIMIT) break
        // A full page with nothing new: more than a page's worth in one
        // second. Step past that second rather than loop on it.
        until = Math.min(...batch.map((e) => e.created_at)) - 1
        continue
      }
      until = Math.min(...batch.map((e) => e.created_at))
    }
    return [...seen.values()]
  } finally {
    pool.close(relays)
  }
}

/** strfry's default `maxFilterLimit`; a relay may cap lower, which only costs an extra page. */
export const RELAY_PAGE_LIMIT = 500
/** A backstop against a relay that ignores `until`: 100 pages, 50,000 events. */
const MAX_READ_PAGES = 100

export async function newestAddressable(
  pubkey: string,
  kind: number,
  d: string,
  relays: string[] = [RELAY_URL],
): Promise<Event | null> {
  const pool = readPool()
  try {
    // BOTH STORES, NEWEST WINS (DEV-144) — see the header of lib/gatewayNostr.
    // Without the gateway read, a deployment that does not publish strfry's
    // port loses the merchant role entirely: this record IS what makes a
    // merchant a merchant, and logout wipes the device.
    const [relayed, cached] = await Promise.all([
      pool
        .querySync(
          relays,
          { authors: [pubkey], kinds: [kind], '#d': [d] },
          { maxWait: READ_CONNECT_TIMEOUT_MS },
        )
        .catch(() => [] as Event[]),
      gatewayEvents(pubkey, kind, d),
    ])

    // Checked again locally on BOTH sides. `#d` now goes on the wire to each
    // (the gateway honours a standard tag filter since the DEV-144 re-check),
    // but a store that ignores it would otherwise satisfy `imani:merchant` with
    // any other kind-30078 this key has published — `imani:settings` and
    // everything else possa-merchant writes under this kind.
    return (
      [...relayed, ...cached]
        .filter((e) => e.tags.some(([name, value]) => name === 'd' && value === d))
        // Sort rather than trust order: querySync merges several relays' replies
        // and makes no promise about which arrives first.
        .sort((a, b) => b.created_at - a.created_at)[0] ?? null
    )
  } finally {
    pool.close(relays)
  }
}
