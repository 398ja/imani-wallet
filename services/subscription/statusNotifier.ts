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
import { Relay, type Event } from 'nostr-tools'

import { wrapMessage } from '../../src/lib/giftWrap.ts'
import { subscriptionStatusJson, type SubscriptionStatusMessage } from '../../src/lib/subscriptionStatus.ts'
import type { Seller } from './issuer.ts'

export interface StatusNotifier {
  notify(stallPubkey: string, message: SubscriptionStatusMessage): Promise<void>
}

/** Publish one event to a relay and wait for its OK, within `timeoutMs`. */
async function publishTo(url: string, event: Event, timeoutMs: number): Promise<void> {
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
}): StatusNotifier {
  const publish = opts.publish ?? ((url, event) => publishTo(url, event, opts.timeoutMs ?? 5000))
  return {
    async notify(stallPubkey, message) {
      const wrap = wrapMessage(opts.seller.sk, stallPubkey, subscriptionStatusJson(message))
      await publish(opts.relayUrl, wrap)
    },
  }
}
