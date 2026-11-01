import type { Event } from 'nostr-tools'

import { getSigner } from './nap'
import { advertisedShop, onlineShopUnconfirmed, syncOnlineShop, type ProfilePublisher } from './onlineShopProfile'
import { loadMerchant } from './merchant'
import { publish as relayPublish } from './relay'
import { allTerminals, onRosterChanged } from './terminalRoster'
import { mirrorToGateway } from './transferSignature'

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

const RETRY_MS = 5_000
const RETRIES = 24
let stopWatch: (() => void) | null = null

/**
 * Keep the stall's `online_shop` in step with its roster from ANY screen (#402). The republish used
 * to run only while Terminals was open, so a shop whose row turned In service from the DM poll
 * (owner on another screen) or from a roster merge was never advertised: staging 2026-10-31, the
 * stall's profile did not name its shop until Terminals was opened. Runs once at login, then on
 * every roster write, retrying an unconfirmed publish. Started on login, stopped on logout.
 */
export function startOnlineShopSync(
  stallPubkey: string,
  publisher: ProfilePublisher = profilePublisherVia((e) => relayPublish(e, undefined, { connectMs: 8000 }), mirrorToGateway),
): () => void {
  stopWatch?.()
  let timer: ReturnType<typeof setTimeout> | undefined
  let run = 0
  const attempt = async (id: number, left: number) => {
    const rows = allTerminals(stallPubkey)
    // A stall that never had a shop has nothing to say: no profile republish on every login.
    if (!advertisedShop(rows) && !loadMerchant(stallPubkey)?.onlineShop) return
    const out = await syncOnlineShop(stallPubkey, rows, publisher).catch(() => ({ changed: true, published: false }))
    const failed = !out.published && (out.changed || onlineShopUnconfirmed(stallPubkey))
    if (id === run && failed && left > 0) timer = setTimeout(() => void attempt(id, left - 1), RETRY_MS)
  }
  const kick = () => {
    clearTimeout(timer)
    void attempt(++run, RETRIES)
  }
  const off = onRosterChanged((stall) => stall === stallPubkey && kick())
  kick()
  stopWatch = () => {
    run++
    clearTimeout(timer)
    off()
    stopWatch = null
  }
  return stopWatch
}

export function stopOnlineShopSync(): void {
  stopWatch?.()
}
