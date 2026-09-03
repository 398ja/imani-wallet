/**
 * Is this recipient trading as a stall, and which one?
 *
 * The one question on this service that needs the network, and the reason the
 * answer has THREE values rather than two.
 *
 * ## Why `unknown` is not `customer`
 *
 * A coupon is a claim on exactly one stall. Sent to a different stall it is
 * something they cannot honour, cannot redeem and cannot return, and the
 * customer's money simply stops — nothing downstream catches it, because the
 * gateway's send takes a recipient pubkey and does not care who issued what.
 *
 * So the guard needs to know whether a recipient is a stall. When the network
 * cannot be reached, nothing was learned, and the honest answer is `unknown`.
 * Collapsing that into `customer` is what lets a foreign coupon through during
 * an outage, which the app's own `merchantStatus` records as an observed bug.
 *
 * The asymmetry decides how `unknown` is treated: a send blocked by an outage
 * is retried a minute later, while a coupon that lands on a stall that cannot
 * honour it is gone. Only the second is unrecoverable, so this fails closed.
 *
 * ## Why the relay and not the gateway
 *
 * A stall record is a kind-30078 with `d=imani:merchant`, and the relay is the
 * only store that holds it — the app's `merchant.ts` says so at length, and the
 * gateway answers 403 for `/api/v1/merchant/*`. The app additionally reads the
 * gateway's nostrdb cache because a browser cannot always reach strfry; this
 * service runs beside the relay and has no such problem.
 */

import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import type { Event } from 'nostr-tools'
import WebSocketImpl from 'ws'

/**
 * BOTH from `nostr-tools/pool`, and that is not a style choice — the audit API
 * carries the same note for the same measured reason. The root module and the
 * subpath are separate instances each with their own `_WebSocket`, so setting
 * the transport on one while the pool reads the other means every query returns
 * zero events with no error at all.
 *
 * Node has no global `WebSocket` at 20, so without this the service connects to
 * nothing and answers every lookup with `[]` — which here would read as "not a
 * stall" and allow exactly the send this module exists to refuse.
 */
useWebSocketImplementation(WebSocketImpl)

const RELAY_URL = process.env.WALLET_API_RELAY_URL ?? 'ws://nostr-relay:7777'

/** The kind and `d` tag that make an event a stall record, from the app. */
export const STALL_KIND = 30078
export const STALL_D_TAG = 'imani:merchant'

/**
 * How long to wait for the relay before giving up.
 *
 * Bounded, because an unbounded query on the money path means a caller's
 * request hangs for as long as a broken relay keeps a socket open. A timeout
 * produces `unknown`, which refuses the send — the same fail-closed answer as
 * any other unreachable network.
 */
const LOOKUP_TIMEOUT_MS = 5_000

/**
 * How long a POSITIVE answer is cached.
 *
 * Only positives, exactly as the app caches only positives. A lookup that lost
 * a race, or a relay that was briefly unreachable, would otherwise pin "not a
 * stall" on a real stall for the life of the process — and that cached negative
 * is precisely the answer that lets a foreign coupon through.
 *
 * A stall that retires is a rare event and a stale positive is harmless here:
 * it can only cause a REFUSAL of a send to a former stall, never an allowance.
 */
const CACHE_TTL_MS = 5 * 60 * 1000

export type RecipientRole = 'stall' | 'customer' | 'unknown'

export interface StallLookup {
  role(pubkey: string): Promise<RecipientRole>
  clear(): void
}

/**
 * @param query  injectable ONLY so tests can simulate an outage. A fail-closed
 *   path that cannot be tested under failure is a claim rather than a
 *   guarantee, and the failure is the branch that matters most here.
 */
export function createStallLookup(
  query: (pubkey: string) => Promise<Event[]> = queryRelay,
): StallLookup {
  const positives = new Map<string, number>()

  return {
    async role(pubkey) {
      const key = pubkey.toLowerCase()

      const cachedAt = positives.get(key)
      if (cachedAt !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) return 'stall'

      let events: Event[]
      try {
        events = await query(key)
      } catch {
        // Nothing was learned. Saying so is the whole point of this module.
        return 'unknown'
      }

      // Checked locally as well as on the wire: a store that ignored the `#d`
      // filter would otherwise satisfy `imani:merchant` with any other
      // kind-30078 this key has published, and there are several.
      const record = events
        .filter((e) => e.tags.some(([name, value]) => name === 'd' && value === STALL_D_TAG))
        .sort((a, b) => b.created_at - a.created_at)[0]

      if (!record) return 'customer'

      if (!isActiveStall(record)) return 'customer'

      positives.set(key, Date.now())
      return 'stall'
    },

    clear() {
      positives.clear()
    },
  }
}

/**
 * Does this record describe a stall that is still trading?
 *
 * An unparseable record still counts, because publishing it is the act that
 * makes someone a stall — the app's `mergeMerchantEvent` takes the same
 * position. Only an explicit `active: false` retires them: a record missing the
 * field came from a client that does not know about it, not from a retirement.
 *
 * Erring towards "is a stall" is the safe direction here. It can only cause a
 * refusal, never an allowance.
 */
function isActiveStall(event: Event): boolean {
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>
    return content.active !== false
  } catch {
    return true
  }
}

/**
 * Ask the relay for a key's stall record.
 *
 * Throws on failure rather than returning `[]`, and that distinction is the
 * entire fail-closed guarantee: an empty result means "asked, holds nothing",
 * a throw means "could not ask".
 *
 * ## `querySync` alone cannot tell those apart
 *
 * Measured against an unreachable host: `querySync` RESOLVES `[]` after 19ms.
 * No error, no rejection, no timeout — an unreachable relay is byte-identical
 * to a relay holding no record, and that reads as `customer`, which ALLOWS a
 * cross-stall send. The fail-closed guarantee was silently absent, every unit
 * test passed, and the container proved otherwise on the first real request.
 *
 * The tests could not have caught it: they injected a query that THREW, which
 * is an outage shape `querySync` never actually produces.
 *
 * `ensureRelay` is the seam that does distinguish them — it rejects with
 * `connection failed` when the socket cannot open. So the connection is
 * established FIRST and explicitly, and only a live relay is queried. Now an
 * empty result genuinely means "asked, holds nothing".
 */
async function queryRelay(pubkey: string): Promise<Event[]> {
  const pool = new SimplePool()
  try {
    return await withTimeout(
      (async () => {
        // Throws when the socket cannot open, which is the whole point.
        const relay = await pool.ensureRelay(RELAY_URL)

        // Connected, but assert it rather than assume: a relay object that
        // reports itself disconnected would query to `[]` just as silently.
        if (!relay.connected) throw new Error('relay is not connected')

        return pool.querySync([RELAY_URL], {
          authors: [pubkey],
          kinds: [STALL_KIND],
          '#d': [STALL_D_TAG],
        })
      })(),
      LOOKUP_TIMEOUT_MS,
    )
  } finally {
    pool.close([RELAY_URL])
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay lookup timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
