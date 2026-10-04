import type { HoldReason, RedemptionHeldEvent } from '@imani/dm-poll'

import { createAccountStore } from './accountStore'

/**
 * Coupons the trusted-mint gate is HOLDING: received, not credited, not lost
 * (imani-wallet#133 review, HIGH-2 and MEDIUM-2).
 *
 * A held coupon's delivery is left unconsumed, so dm-poll offers it again on
 * every poll and redeems it the moment the configuration names its mint. Before
 * this list the wait was silent: nothing on screen, and a coupon older than the
 * poll window (seven days) simply stopped being offered. So each hold is recorded
 * here, the wallet shows a "waiting to be verified" notice while any remain, and
 * the poller re-offers these ids specifically, however old, when the trusted
 * mints change.
 *
 * Display and bookkeeping only. No token is stored: the delivery is still on the
 * relay, and keeping bearer proofs in localStorage would add a copy for nothing.
 */

export interface HeldCoupon {
  /** The gift wrap, which is what makes one delivery one record. */
  eventId: string
  voucherId: string
  reason: HoldReason
  /** Who sent it: the payload's payer when it names one, else the wrap's signer. */
  senderPubkey?: string
  /** Display only, sender-written. */
  faceValue?: number
  faceUnit?: string
  faceDecimals?: number
  /** When the delivery was created, epoch seconds: how far back to look for it. */
  createdAt: number
  /** Epoch ms of the first hold, for ordering and trimming. */
  at: number
}

/** Far above anything that should ever be waiting at once. */
const MAX_HELD = 200

/** Fired on `window` when the held list changes, so an open notice redraws. */
export const HELD_CHANGED = 'imani:held-coupons-changed'

const store = createAccountStore<HeldCoupon>({
  name: 'held-coupons',
  limit: MAX_HELD,
  idOf: (c) => c.eventId,
  ageOf: (c) => c.at,
  isValid: (c): c is HeldCoupon =>
    !!c &&
    typeof c === 'object' &&
    typeof (c as HeldCoupon).eventId === 'string' &&
    typeof (c as HeldCoupon).createdAt === 'number',
})

function changed(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(HELD_CHANGED))
  }
}

/**
 * Remember one hold. Never throws: it runs from an event handler on the
 * redemption path. Returns true the first time this delivery is held, so the
 * caller announces it once rather than on every poll.
 */
export function recordHeld(pubkey: string, event: RedemptionHeldEvent | undefined, now = Date.now()): boolean {
  try {
    if (!pubkey || !event?.eventId) return false
    const existing = store.get(pubkey, event.eventId)
    store.put(pubkey, {
      eventId: event.eventId,
      voucherId: event.voucherId,
      reason: event.reason,
      senderPubkey: (event.payerPubkey ?? event.senderPubkey)?.toLowerCase(),
      faceValue: event.faceValue,
      faceUnit: event.faceUnit,
      faceDecimals: event.faceDecimals,
      createdAt: event.createdAt,
      at: existing?.at ?? now,
    })
    if (!existing || existing.reason !== event.reason) changed()
    return !existing
  } catch (e) {
    console.warn('[held] could not remember a held coupon:', e)
    return false
  }
}

/** The delivery was redeemed after all. Never throws. */
export function releaseHeld(pubkey: string, eventId: string | undefined): void {
  try {
    if (!pubkey || !eventId) return
    if (store.remove(pubkey, eventId)) changed()
  } catch (e) {
    console.warn('[held] could not forget a released coupon:', e)
  }
}

/** Every coupon still waiting, oldest first. */
export function heldCoupons(pubkey: string): HeldCoupon[] {
  if (!pubkey) return []
  return store.list(pubkey).sort((a, b) => a.at - b.at)
}

/**
 * What the wallet says while coupons are waiting. Worded for whoever is holding
 * the phone: their coupon is safe, nothing was taken, and it arrives on its own
 * once the market's configuration is confirmed. Never an accusation: the usual
 * cause is a configuration mismatch, not a forgery.
 */
export function heldSummary(held: readonly HeldCoupon[], cashbackWaiting = 0): string | undefined {
  const total = held.length + cashbackWaiting
  if (total === 0) return undefined
  const one = total === 1
  return (
    `${total} ${one ? 'coupon is' : 'coupons are'} waiting to be verified. ` +
    `Nothing was taken: ${one ? 'it' : 'they'} will arrive on ${one ? 'its' : 'their'} own once this market ` +
    'confirms where coupon value is held.'
  )
}
