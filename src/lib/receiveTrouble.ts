import type { RedemptionErrorEvent, RedemptionUnsavedEvent } from '@imani/dm-poll'

import { createAccountStore } from './accountStore'

/**
 * Coupons that answered a payment request and then did not make it into this wallet
 * (imani-wallet#300).
 *
 * The till can now show Paid on gateway-core's verdict, before the coupons arrive. The money is
 * counted by core; the coupons are the merchant's custody. So when their receive later fails, the
 * Paid stays and the merchant is told the coupons have not reached this wallet, rather than the
 * failure vanishing into a toast nobody at the counter saw.
 *
 * Display only, like the refused and held lists beside it. Keyed on the gift wrap, so one delivery
 * is one record however many times dm-poll reports it.
 *
 * - `failed`: the receive gave up, either for good (`retryable: false`, a token the mint will
 *   never accept) or for now (the wallet tries again in this session, #314).
 * - `unsaved`: the gateway settled the receive but the proofs did not reach this wallet; it needs
 *   reconciliation, and `receiveId` names the escrow.
 *
 * The request id comes from the DM, so it is sender-written. That is enough for a display note on
 * a request the till already holds Paid: it can never make a request read as paid.
 */
export interface ReceiveTrouble {
  eventId: string
  requestId: string
  kind: 'failed' | 'unsaved'
  /**
   * `failed` only: false when dm-poll gave up on the delivery for good (#314), so the till must
   * not promise another try. Absent on older records: read as retryable.
   */
  retryable?: boolean
  receiveId?: string
  /** Epoch ms. */
  at: number
}

const MAX_TROUBLES = 100

/** Fired on `window` when the list changes, so an open till redraws. */
export const RECEIVE_TROUBLE_CHANGED = 'imani:receive-trouble-changed'

const store = createAccountStore<ReceiveTrouble>({
  name: 'receive-trouble',
  limit: MAX_TROUBLES,
  idOf: (t) => t.eventId,
  ageOf: (t) => t.at,
  isValid: (t): t is ReceiveTrouble =>
    !!t &&
    typeof t === 'object' &&
    typeof (t as ReceiveTrouble).eventId === 'string' &&
    typeof (t as ReceiveTrouble).requestId === 'string',
})

function changed(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(RECEIVE_TROUBLE_CHANGED))
  }
}

/** Remember one. Never throws: it runs from dm-poll's event handlers. */
export function recordReceiveTrouble(
  pubkey: string,
  trouble: Omit<ReceiveTrouble, 'at'> & { at?: number },
): void {
  try {
    if (!pubkey || !trouble.eventId || !trouble.requestId) return
    store.put(pubkey, { ...trouble, at: trouble.at ?? Date.now() })
    changed()
  } catch (e) {
    console.warn('[receiveTrouble] could not remember a failed receive:', e)
  }
}

/** The delivery was redeemed after all (a retry worked): forget it. */
export function clearReceiveTrouble(pubkey: string, eventId: string | undefined): void {
  try {
    if (!pubkey || !eventId) return
    if (store.remove(pubkey, eventId)) changed()
  } catch (e) {
    console.warn('[receiveTrouble] could not forget a receive:', e)
  }
}

/** The troubles recorded against one request, newest first. */
export function receiveTroubleFor(pubkey: string, requestId: string): ReceiveTrouble[] {
  if (!pubkey || !requestId) return []
  return store.list(pubkey).filter((t) => t.requestId === requestId)
}

/** From dm-poll's `redemption:error`, when the delivery named a request. */
export function fromRedemptionError(pubkey: string, event: RedemptionErrorEvent | undefined): void {
  if (!event?.requestId) return
  recordReceiveTrouble(pubkey, {
    eventId: event.eventId,
    requestId: event.requestId,
    kind: 'failed',
    // #314: only a refusal dm-poll will never retry is permanent.
    retryable: event.retryable !== false,
  })
}

/** From dm-poll's `redemption:unsaved`, when the delivery named a request. */
export function fromRedemptionUnsaved(pubkey: string, event: RedemptionUnsavedEvent | undefined): void {
  if (!event?.requestId) return
  recordReceiveTrouble(pubkey, {
    eventId: event.eventId,
    requestId: event.requestId,
    kind: 'unsaved',
    ...(event.receiveId ? { receiveId: event.receiveId } : {}),
  })
}
