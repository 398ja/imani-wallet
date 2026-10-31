import type { Event } from 'nostr-tools'

import { getSigner } from './nap'
import type { ProfilePublisher } from './onlineShopProfile'

/**
 * The stall's own signer, the relay, and the gateway's mirror (as the roster publishes,
 * terminalRosterSyncNet.ts). Only the RELAY's acceptance counts as published: the gateway's
 * cache prunes any addressable event the relay does not also hold (imani-nostrdb
 * pruned_superseded_replaceables), so a mirror-only copy vanishes on the next read and a
 * "published" mark from it stops the retry (staging 2026-10-31).
 */
export function profilePublisherVia(
  relay: (e: Event) => Promise<{ ok: number; errors: string[] }>,
  mirror: (e: Event) => Promise<boolean>,
  sign: ProfilePublisher['sign'] = (template) => getSigner().signEvent(template) as unknown as Promise<{ created_at: number }>,
): ProfilePublisher {
  return {
    sign,
    publish: async (signed) => {
      const [relayed] = await Promise.all([
        relay(signed as Event).then(
          (r) => {
            if (r.ok === 0) console.warn(`[online-shop] relay did not take the profile: ${r.errors.join('; ') || 'no answer'}`)
            return r.ok
          },
          (e: unknown) => (console.warn(`[online-shop] relay publish threw: ${String(e)}`), 0),
        ),
        mirror(signed as Event).catch(() => false),
      ])
      return { ok: relayed }
    },
  }
}
