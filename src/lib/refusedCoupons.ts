import type { RedemptionRefusedEvent } from '@imani/dm-poll'

import { createAccountStore } from './accountStore'
import { REFUSAL_MESSAGES } from './refusalToast'

/**
 * Coupons this wallet refused before the mint swap, kept so the PAYMENT they
 * belonged to can say so (#145).
 *
 * The refusal toast lasts ten seconds. On staging a two-coupon payment had one
 * coupon refused: the customer was told the payment completed, and the till
 * showed nothing that would let staff ask for the rest. So each refusal that
 * names a payment (a bundle, or a payment request) is remembered on this
 * device, and the payment's screens read it back.
 *
 * Display only. Nothing here touches the ledger: a refused coupon was never
 * swapped and is still the sender's.
 */

export interface RefusedCoupon {
  /** The gift wrap, which is what makes one delivery one record. */
  eventId: string
  voucherId: string
  reason: RedemptionRefusedEvent['reason']
  bundleId?: string
  bundlePartCount?: number
  requestId?: string
  /** Epoch ms, for trimming the oldest first. */
  at: number
}

/** Far above anything a stall has in front of it at once. */
const MAX_REFUSALS = 100

/** Fired on `window` when a refusal is recorded, so an open payment redraws. */
export const REFUSALS_CHANGED = 'imani:refused-coupons-changed'

const store = createAccountStore<RefusedCoupon>({
  name: 'refused-coupons',
  limit: MAX_REFUSALS,
  idOf: (r) => r.eventId,
  ageOf: (r) => r.at,
  isValid: (r): r is RefusedCoupon =>
    !!r && typeof r === 'object' && typeof (r as RefusedCoupon).eventId === 'string',
})

/**
 * Remember one refusal against the payment it belonged to. Never throws: it
 * runs from an event handler on the redemption path.
 */
export function recordRefusal(pubkey: string, event: RedemptionRefusedEvent | undefined, now = Date.now()): void {
  try {
    if (!pubkey || !event?.eventId || !event.reason) return
    if (!event.bundleId && !event.requestId) return
    store.put(pubkey, {
      eventId: event.eventId,
      voucherId: event.voucherId,
      reason: event.reason,
      bundleId: event.bundleId,
      bundlePartCount: event.bundlePartCount,
      requestId: event.requestId,
      at: now,
    })
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event(REFUSALS_CHANGED))
    }
  } catch (e) {
    console.warn('[refusal] could not remember a refused coupon:', e)
  }
}

/** The refusals for one payment, matched by bundle or by request. */
export function refusalsFor(pubkey: string, payment: { bundleId?: string; requestId?: string }): RefusedCoupon[] {
  if (!pubkey || (!payment.bundleId && !payment.requestId)) return []
  return store
    .list(pubkey)
    .filter(
      (r) =>
        (payment.bundleId !== undefined && r.bundleId === payment.bundleId) ||
        (payment.requestId !== undefined && r.requestId === payment.requestId),
    )
}

/**
 * "1 of 2 coupons refused: that coupon is already spent". Undefined when
 * nothing was refused. The count is the sender's declaration, so it is only
 * shown when they made one.
 */
export function refusalSummary(refusals: readonly RefusedCoupon[]): string | undefined {
  if (refusals.length === 0) return undefined
  const declared = Math.max(0, ...refusals.map((r) => r.bundlePartCount ?? 0))
  const count = declared >= refusals.length ? `${refusals.length} of ${declared}` : `${refusals.length}`
  const noun = declared > 1 || refusals.length > 1 ? 'coupons' : 'coupon'
  // In the order they were refused, which is the order staff will explain them.
  const inOrder = [...refusals].sort((a, b) => a.at - b.at)
  const reasons = [...new Set(inOrder.map((r) => REFUSAL_MESSAGES[r.reason]?.title.toLowerCase()))].filter(Boolean)
  return `${count} ${noun} refused: ${reasons.join('; ')}`
}
