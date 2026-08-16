import { SimplePool, type Event } from 'nostr-tools'

/**
 * Publishing to the Nostr relay.
 *
 * Reads proxy through the gateway's nostrdb cache (see lib/branding.ts), but
 * WRITES go straight to the relay from the browser. That split is why
 * deploy/compose.override.yml publishes strfry's port at all — upstream's
 * docker-compose.test.yml exposes it only on the internal Docker network.
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
 * scripts/seed-farmer.mjs draws the same distinction, for the same reason.
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
 * read STRAIGHT FROM THE RELAY.
 *
 * Deliberately not routed through the gateway's nostrdb cache the way
 * `fetchNewestKind0` in lib/branding.ts is, for two reasons that have each
 * already cost a debugging round:
 *
 * - The cache lags the relay. Reads and writes landing in different stores is
 *   what makes `Profile.eventAt` load-bearing (§14.3); merchant metadata is
 *   written here and would be read back stale.
 * - The gateway ignores Nostr-standard tag filters — it reads its own `pTags`
 *   field and will happily hand back everything it has. A `#d` filter sent
 *   there is not a filter, it is a suggestion.
 *
 * So `#d` goes on the wire for relays that honour it, and the result is checked
 * again locally for those that do not. Without that second check a merchant's
 * `imani:merchant` record could be satisfied by any other kind-30078 the same
 * key has published — `imani:settings`, and everything else possa-merchant
 * writes under this kind.
 *
 * No `ws` polyfill here, unlike scripts/seed-farmer.mjs — that is a Node 20
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
  const events = await allEvents(pubkey, kind, relays)

  const newest = new Map<string, Event>()
  for (const event of events) {
    const d = event.tags.find(([name]) => name === 'd')?.[1]
    if (!d?.startsWith(dPrefix)) continue
    const seen = newest.get(d)
    if (!seen || event.created_at > seen.created_at) newest.set(d, event)
  }
  return [...newest.values()]
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
    const events = await pool.querySync(relays, { authors: [pubkey], kinds: [kind], '#d': [d] })
    return (
      events
        .filter((e) => e.tags.some(([name, value]) => name === 'd' && value === d))
        // Sort rather than trust order: querySync merges several relays' replies
        // and makes no promise about which arrives first.
        .sort((a, b) => b.created_at - a.created_at)[0] ?? null
    )
  } finally {
    pool.close(relays)
  }
}
