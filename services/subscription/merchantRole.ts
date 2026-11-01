/**
 * Is this key a merchant? Read from the stall's own signed public record, as the gateway does
 * (#411, owner 2026-10-28: the subscription pages are merchant-only).
 *
 * A merchant is a pubkey with a live kind-30078 `d=imani:merchant` record (`src/lib/merchant.ts`,
 * gateway-core `MerchantAclService`). There is no role flag anywhere else to read. A customer key,
 * or a stall that retired its record (`active: false`), is not a merchant.
 *
 * Read from the gateway's public `POST /api/v1/nostr/query`, the read `purchase-issuer`'s
 * `stallValidity.ts` already makes, with the same trust rules: only events the stall SIGNED,
 * kind 30078, exactly the `imani:merchant` `d` tag; the newest wins.
 *
 * Three answers, kept apart:
 * - `merchant`: signed, live record.
 * - `customer`: the gateway answered and there is no live signed record. A DENIAL.
 * - `unknown`: the gateway could not be asked. Also a denial for this request (fail closed), but
 *   not a "this person is not a merchant" fact, so sessions are not revoked on it.
 */
import { verifyEvent, type Event } from 'nostr-tools/pure'

export const MERCHANT_KIND = 30078
export const MERCHANT_D_TAG = 'imani:merchant'
export const NOSTR_QUERY_PATH = '/api/v1/nostr/query'
export const ROLE_MERCHANT = 'merchant'

/** Successful answers only, so a stall that just published sees it within a minute. */
export const MERCHANT_CACHE_MS = 60_000
const TIMEOUT_MS = 5_000

export type MerchantStanding = 'merchant' | 'customer' | 'unknown'
export type MerchantReader = (pubkey: string) => Promise<MerchantStanding>

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
  return { id: raw.id, kind: raw.kind, pubkey: raw.pubkey, content: raw.content, tags: raw.tags as string[][], created_at, sig: raw.sig }
}

function isStallRecord(event: Event, pubkey: string): boolean {
  if (event.kind !== MERCHANT_KIND || event.pubkey.toLowerCase() !== pubkey) return false
  const d = event.tags.filter((t) => Array.isArray(t) && t[0] === 'd')
  if (d.length !== 1 || d[0][1] !== MERCHANT_D_TAG) return false
  try {
    return verifyEvent({ ...event })
  } catch {
    return false
  }
}

/**
 * Live means not explicitly retired. Same rule as the wallet's `mergeMerchantEvent`: only an
 * explicit `active: false` deactivates, and a record that does not parse still counts, because
 * publishing it is the act that makes someone a merchant (`isMerchantPubkey`).
 */
function isLive(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { active?: unknown }
    return parsed?.active !== false
  } catch {
    return true
  }
}

/** Pure: the standing a list of candidate events gives this key. */
export function standingFromEvents(events: Event[], pubkey: string): Exclude<MerchantStanding, 'unknown'> {
  const key = pubkey.toLowerCase()
  const newest = events.filter((e) => isStallRecord(e, key)).sort((a, b) => b.created_at - a.created_at)[0]
  return newest && isLive(newest.content) ? 'merchant' : 'customer'
}

export async function readMerchantStanding(gatewayUrl: string, pubkey: string, fetchImpl: typeof fetch = fetch): Promise<MerchantStanding> {
  const key = pubkey.toLowerCase()
  try {
    const response = await fetchImpl(`${gatewayUrl.replace(/\/$/, '')}${NOSTR_QUERY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kinds: [MERCHANT_KIND], authors: [key], tags: { '#d': [MERCHANT_D_TAG] }, limit: 50 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return 'unknown'
    const body = (await response.json()) as { events?: unknown }
    if (!body || !Array.isArray(body.events)) return 'unknown'
    const events = (body.events as RawEvent[]).map((raw) => (raw && typeof raw === 'object' ? toEvent(raw) : null)).filter((e): e is Event => e !== null)
    return standingFromEvents(events, key)
  } catch {
    return 'unknown'
  }
}

/** Cache `merchant` answers briefly. Refusals and failures are always re-asked. */
export function cachedMerchantReader(read: MerchantReader, now: () => number = () => Date.now(), ttlMs = MERCHANT_CACHE_MS): MerchantReader {
  const cache = new Map<string, number>()
  return async (pubkey) => {
    const key = pubkey.toLowerCase()
    const at = cache.get(key)
    if (at !== undefined && now() - at < ttlMs) return 'merchant'
    const standing = await read(key)
    if (standing === 'merchant') cache.set(key, now())
    else cache.delete(key)
    return standing
  }
}
