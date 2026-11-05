/**
 * Tell a stall's wallet that its subscription was cancelled in Stripe, or un-cancelled (#407).
 *
 * The licence the wallet holds runs to its own expiry and carries no renewal flag, so without this
 * the wallet would go on saying "Active" after the stall cancelled. Stripe's webhook is what tells
 * this service; this tells the wallet, as a NIP-17 DM SEALED BY THE SELLER (the key the wallet
 * pins for licences), published to the relay gateway-customer indexes for the wallet's DM poll.
 *
 * Display only: it never grants or revokes (the paid-for plan runs to its end, #407 §6). Delivery
 * is best effort and never fails the webhook; a lost message only means the wallet keeps saying
 * "Active" until the plan ends, which is what it did before this existed.
 */
// BOTH from `nostr-tools/relay`, the module that publishes: `nostr-tools` and its subpaths are
// separate module instances, each with its own `_WebSocket` (audit-api/server.ts measured it).
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import type { Event } from 'nostr-tools'
import WebSocketImpl from 'ws'

import { wrapMessage } from '../../src/lib/giftWrap.ts'
import { subscriptionStatusJson, type SubscriptionStatusMessage } from '../../src/lib/subscriptionStatus.ts'
import { eventSizes } from './metrics.ts'
import type { Seller } from './issuer.ts'

/**
 * nostr-tools reaches relays through a GLOBAL `WebSocket`, which Node 20 does not have. Without this
 * the publish threw "WebSocket is not defined" in the built image (seen 2026-10-29 on the local
 * deployment, a real portal cancellation), while every unit test passed with a stubbed publish.
 */
useWebSocketImplementation(WebSocketImpl)

export interface StatusNotifier {
  notify(stallPubkey: string, message: SubscriptionStatusMessage): Promise<void>
}

/** Publish one event to a relay and wait for its OK, within `timeoutMs`. */
export async function publishTo(url: string, event: Event, timeoutMs: number): Promise<void> {
  // Event size (#532): once per publish, before connecting, whatever the outcome. Never throws.
  // Both the status notifier and the badge publisher reach the relay through here.
  eventSizes.recordEvent(event, 'relay')
  const relay = await Promise.race([
    Relay.connect(url),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`connect ${url} timed out`)), timeoutMs)),
  ])
  try {
    await Promise.race([
      relay.publish(event),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`publish to ${url} timed out`)), timeoutMs)),
    ])
  } finally {
    relay.close()
  }
}

export function relayStatusNotifier(opts: {
  seller: Seller
  relayUrl: string
  timeoutMs?: number
  publish?: (url: string, event: Event) => Promise<void>
  /**
   * Also hand the wrap to gateway-customer's index (`POST /api/v1/nostr/events`, signature-checked),
   * which is where the wallet's DM poll reads. The index answers from its cache while it holds any
   * recent wrap for the stall and only then consults the relay, so a second status published only
   * to the relay seconds after the first was not visible (seen 2026-10-29, the undo of a cancel).
   */
  store?: (event: Event) => Promise<void>
}): StatusNotifier {
  const publish = opts.publish ?? ((url, event) => publishTo(url, event, opts.timeoutMs ?? 5000))
  return {
    async notify(stallPubkey, message) {
      // Not backdated (blur 0): a cancellation and its undo are seconds apart, and the wallet's poll
      // would never fetch an undo whose wrap was backdated behind the cancellation it had seen.
      // The timing it would hide is already public: the seller acts when Stripe's webhook fires.
      const wrap = wrapMessage(opts.seller.sk, stallPubkey, subscriptionStatusJson(message), 0)
      // Both, and either is enough for the wallet to see it: the index serves the poll at once, the
      // relay is the record of truth the index refills from. Fail only if neither took it.
      const results = await Promise.allSettled([publish(opts.relayUrl, wrap), opts.store?.(wrap) ?? Promise.reject(new Error('no index'))])
      if (results.every((r) => r.status === 'rejected')) {
        throw new Error(results.map((r) => (r as PromiseRejectedResult).reason?.message ?? r).join('; '))
      }
    },
  }
}
