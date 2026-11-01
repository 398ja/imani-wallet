/**
 * Publish each stall's verification badge (#418): the public, seller-signed attestation the
 * wallet's avatar reads (`src/lib/verificationBadge.ts`).
 *
 * Computed from the LEDGER, not from what the wallet holds: every licence minted for the stall and
 * not revoked, each with the badge its tier earns in the catalog (or, for a hand grant, the badge
 * the grant names, #418 Q3). Republished whenever that set changes: a payment, a renewal, a grant,
 * a revocation. Replaceable, so the newest event is the whole answer and a revocation simply
 * publishes the list without that subscription.
 *
 * Best effort, as the status DM is: a failed publish never fails the payment that triggered it, and
 * the next change (or a resend) publishes the full list again.
 */
import { finalizeEvent, type Event } from 'nostr-tools'
import { badgeOf, type TierCatalog } from '@imani/licence'

import { VERIFICATION_KIND, verificationD, verificationJson, type BadgeWindow } from '../../src/lib/verificationBadge.ts'
import type { SubscriptionRow } from './ledger.ts'
import type { Seller } from './issuer.ts'

export interface BadgePublisher {
  publish(stallPubkey: string, rows: readonly SubscriptionRow[]): Promise<void>
}

/** The badge windows a stall's ledger rows earn. Revoked rows and licences never minted earn none. */
export function badgeWindowsFor(rows: readonly SubscriptionRow[], catalog: TierCatalog): BadgeWindow[] {
  const out: BadgeWindow[] = []
  for (const row of rows) {
    if (row.status === 'revoked') continue
    const badge = badgeOf({ tier: row.tier, badge: row.badge }, catalog)
    if (!badge) continue
    for (const l of row.licences) {
      // Owed or failed: nothing was minted, so the stall holds nothing to be verified by.
      if (l.state !== 'minted' && l.state !== 'delivered') continue
      out.push({ badge, validFrom: l.validFrom, validTo: l.validTo })
    }
  }
  return out
}

/** The signed event for one stall. `createdAt` in unix SECONDS. */
export function verificationEvent(seller: Seller, stallPubkey: string, windows: readonly BadgeWindow[], createdAt: number): Event {
  return finalizeEvent(
    {
      kind: VERIFICATION_KIND,
      created_at: createdAt,
      tags: [
        ['d', verificationD(stallPubkey)],
        // Lets a relay index it by stall, and a reader find every attestation about one key.
        ['p', stallPubkey.toLowerCase()],
      ],
      content: verificationJson(stallPubkey, windows),
    },
    seller.sk,
  )
}

export function relayBadgePublisher(opts: {
  seller: Seller
  catalog: TierCatalog
  relayUrl: string
  publish: (url: string, event: Event) => Promise<void>
  store?: (event: Event) => Promise<void>
  now?: () => number
  log?: (e: Record<string, unknown>) => void
}): BadgePublisher {
  // A replaceable event is replaced only by a NEWER `created_at`. Two changes for one stall in one
  // second (a grant then its delivery) would otherwise leave the first standing, so per stall this
  // never goes back.
  const last = new Map<string, number>()
  return {
    async publish(stallPubkey, rows) {
      const nowS = Math.floor((opts.now?.() ?? Date.now()) / 1000)
      const createdAt = Math.max(nowS, (last.get(stallPubkey) ?? 0) + 1)
      last.set(stallPubkey, createdAt)
      const event = verificationEvent(opts.seller, stallPubkey, badgeWindowsFor(rows, opts.catalog), createdAt)
      const results = await Promise.allSettled([
        opts.publish(opts.relayUrl, event),
        opts.store?.(event) ?? Promise.reject(new Error('no index')),
      ])
      if (results.every((r) => r.status === 'rejected')) {
        opts.log?.({ event: 'badge_publish_failed', stall: stallPubkey, error: results.map((r) => String((r as PromiseRejectedResult).reason)).join('; ') })
        return
      }
      opts.log?.({ event: 'badge_published', stall: stallPubkey, windows: JSON.parse(event.content).badges.length })
    },
  }
}
