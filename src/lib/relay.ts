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
export const INTERNAL_RELAY_URL: string =
  import.meta.env.VITE_INTERNAL_RELAY_URL ?? 'ws://nostr-relay:7777'

export interface PublishResult {
  ok: number
  total: number
  /** Reasons the failed relays gave, for a message the user can act on. */
  errors: string[]
}

/**
 * Publish a signed event, resolving with a count rather than throwing.
 *
 * A partial publish is the normal case on Nostr, not an error: the event is
 * live as soon as one relay accepts it. Callers report "n/m" and carry on, which
 * is why this never rejects.
 */
export async function publish(event: Event, relays: string[] = [RELAY_URL]): Promise<PublishResult> {
  const pool = new SimplePool()
  try {
    const results = await Promise.allSettled(pool.publish(relays, event))
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))

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
  const pool = new SimplePool()
  try {
    return await pool.querySync(relays, { authors: [pubkey], kinds: [kind] })
  } finally {
    pool.close(relays)
  }
}

export async function newestAddressable(
  pubkey: string,
  kind: number,
  d: string,
  relays: string[] = [RELAY_URL],
): Promise<Event | null> {
  const pool = new SimplePool()
  try {
    // BOTH STORES, NEWEST WINS (DEV-144) — see the header of lib/gatewayNostr.
    // Without the gateway read, a deployment that does not publish strfry's
    // port loses the merchant role entirely: this record IS what makes a
    // merchant a merchant, and logout wipes the device.
    const [relayed, cached] = await Promise.all([
      pool
        .querySync(relays, { authors: [pubkey], kinds: [kind], '#d': [d] })
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
