/**
 * Which coupons this wallet has already spent, according to its own tombstones.
 *
 * The wallet publishes a tombstone for every coupon it removes — a kind-7375
 * token event whose `d` is the coupon's `token_id` and whose `spent` tag is
 * `true` (`voucherRecords.ts`). Until now nothing read them except
 * `restoreVouchers`, at login. So a coupon spent on one device stayed spendable
 * on another until that device happened to restore.
 *
 * ## Why offering one is worse than a failed request
 *
 * The gateway refuses the split with `SOURCE_PROOFS_NOT_UNSPENT`, and
 * `initiateOnFirstFree` records what that costs here: a send which fails after
 * the split cannot be reclaimed on this stack, so the saga parks and the coupon
 * is STUCK rather than merely rejected. A stale row strands money.
 *
 * ## Only ever subtracts
 *
 * This module can refuse a coupon. It can never restore one, and it never
 * answers "this coupon is live" — only "this id has a tombstone". A read that
 * fails, times out, or returns nothing leaves the holding exactly as it was.
 *
 * That asymmetry is what makes it safe to put on the payment path. The
 * dangerous direction — treating silence as "nothing is spent" and offering
 * everything — is the current behaviour, so a failed read is no worse than not
 * having asked.
 */

import type { Event } from 'nostr-tools'

import { allEvents } from './relay'
import { gatewayEvents } from './gatewayNostr'
import { NIP60_TOKEN_KIND } from './voucherRecords'

/**
 * How long a fetched set is reused.
 *
 * Per session rather than per send, because the read sits in front of a payment
 * and a customer at a market stall is waiting. Long enough that a burst of
 * sends costs one read; short enough that a second device's spend is seen
 * within a few minutes.
 *
 * Staleness here is bounded by the LOCAL status check as well: `spendable`
 * already drops a row marked `spent` or `redeemed`, so this only has to catch
 * the window before that status reaches this device.
 */
const CACHE_TTL_MS = 2 * 60 * 1000

/**
 * How long to wait before giving up and answering "unknown".
 *
 * Bounded tightly, and deliberately tighter than the relay lookups elsewhere in
 * this app: those answer a question the user asked, while this one runs before
 * a payment the user is standing at a counter to complete. A slow relay must
 * cost a stale answer, never a delayed send.
 */
const READ_TIMEOUT_MS = 2_500

/**
 * The answer, with "could not tell" kept DISTINCT from "nothing is spent".
 *
 * An empty `Set` from a failed read and an empty `Set` from a wallet that has
 * spent nothing are the same value and mean opposite things, and conflating
 * them is the specific way this feature would fail silently. #36 is the
 * precedent: a gateway that returned zero gift wraps looked exactly like a
 * customer with no coupons, and the wallet had no way to know the list was
 * short.
 *
 * So callers get `known: false` and must not conclude anything from `ids` being
 * empty.
 */
export interface SpentIds {
  ids: Set<string>
  /** True only when at least one source answered. */
  known: boolean
}

let cached: { pubkey: string; at: number; value: SpentIds } | null = null

/** Drop the cache. For tests, and for a wallet changing identity. */
export function forgetSpentIds(): void {
  cached = null
}

/**
 * The `token_id`s carrying a tombstone, read WITHOUT decrypting anything.
 *
 * `buildRecord` puts `spent` in a tag as well as in the sealed payload, exactly
 * so a reader can do this, and here it is the whole mechanism rather than an
 * optimisation: the tag and the `d` are both public, so this module never needs
 * the customer's key and never opens a NIP-44 seal.
 *
 * An event whose tag says anything else is ignored. This module's only job is
 * to name tombstones; deciding what a non-tombstone record MEANS belongs to
 * `pickLive`, which has the decrypted payload.
 */
function tombstonedIds(events: Event[]): string[] {
  const ids: string[] = []
  for (const event of events) {
    if (event.tags.find(([name]) => name === 'spent')?.[1] !== 'true') continue
    const id = event.tags.find(([name]) => name === 'd')?.[1]
    if (id) ids.push(id)
  }
  return ids
}

function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), READ_TIMEOUT_MS)),
  ])
}

/**
 * Read the tombstones from BOTH stores and union them.
 *
 * Both, because neither is sufficient alone and the app already learned this
 * the hard way (DEV-144, and the header of `lib/gatewayNostr`):
 *
 * - **The relay alone** needs strfry reachable FROM THE BROWSER, and a real
 *   deployment does not publish that port. The read would return nothing, every
 *   time, silently.
 * - **The gateway alone** is not where this wallet writes. Its ingest pump
 *   subscribes to kind-1059 gift wraps only, so a 7375 published straight to
 *   the relay may never enter its nostrdb at all — and #36 showed the gateway
 *   returning short lists even for the kind it does ingest.
 *
 * The merge is a UNION, which is simpler than the newest-wins rule
 * `newestAddressable` needs, and simpler for a reason worth stating: a
 * tombstone is FINAL. `token_id` is `sha256(token)`, so an id that was spent is
 * spent forever and no later event can un-spend it. Either source seeing one is
 * enough, and a stale source can only ever MISS a tombstone — never invent one.
 *
 * So the failure modes are: miss a spend and behave exactly as today, or see it
 * and refuse. Neither can lose a coupon.
 */
async function readSpentIds(pubkey: string): Promise<SpentIds> {
  const NONE: Event[] = []

  // Settled rather than raced, so one source failing does not discard the
  // other's answer — the union is worth having even from one store.
  const [relayed, gatewayed] = await Promise.all([
    withTimeout(allEvents(pubkey, NIP60_TOKEN_KIND), NONE),
    withTimeout(gatewayEvents(pubkey, NIP60_TOKEN_KIND), NONE),
  ])

  const ids = new Set<string>([...tombstonedIds(relayed), ...tombstonedIds(gatewayed)])

  // `known` is about whether anything ANSWERED, not whether anything was found.
  // A wallet that has spent nothing legitimately has an empty set, and a
  // caller must be able to tell that from a read that failed.
  const known = relayed.length > 0 || gatewayed.length > 0

  return { ids, known }
}

/**
 * The spent set for this customer, cached for the session.
 *
 * Never throws and never blocks longer than `READ_TIMEOUT_MS`. A failed read
 * answers `{ ids: empty, known: false }`, which every caller must treat as "no
 * information" rather than "nothing is spent".
 *
 * A failed read is NOT cached. Caching it would turn one bad moment into a
 * TTL's worth of blindness on the money path, and the next send should get a
 * fresh chance to learn the truth.
 */
export async function spentTokenIds(pubkey: string): Promise<SpentIds> {
  const now = Date.now()
  if (cached && cached.pubkey === pubkey && now - cached.at < CACHE_TTL_MS) {
    return cached.value
  }

  try {
    const value = await readSpentIds(pubkey)
    if (value.known) cached = { pubkey, at: now, value }
    return value
  } catch (error) {
    // Unreachable in practice — both reads catch their own failures — but the
    // guarantee that this never throws belongs to THIS function rather than to
    // the internals of the two it calls. An exception escaping here would
    // reach the send path, where it would look like a failed payment.
    console.warn('[spentCoupons] could not read tombstones; offering the holding unchanged', error)
    return { ids: new Set(), known: false }
  }
}

/**
 * Drop coupons carrying a tombstone.
 *
 * Returns the rows unchanged when nothing is known, which is the same answer as
 * "nothing is tombstoned" by design: both mean this module has no reason to
 * remove anything, and the send proceeds exactly as it did before this existed.
 */
export function withoutSpent<T extends { token_id?: string }>(rows: T[], spent: SpentIds): T[] {
  if (!spent.known || spent.ids.size === 0) return rows
  return rows.filter((row) => !(row.token_id && spent.ids.has(row.token_id)))
}
