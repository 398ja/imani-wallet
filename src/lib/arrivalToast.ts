import { createElement } from 'react'
import { toast } from 'sonner'

import { ReceivedPaymentToast } from '../components/ui/IncomingPaymentToast'
import { currencyDecimals, formatFace } from './format'

/**
 * The toast that fires when a coupon has ACTUALLY arrived.
 *
 * The wallet already had an incoming-payment toast, but it only ever fired from
 * one place: the Artemis advance-notice queue, which is fed by exactly one
 * caller — `AtomicSendService.processDmDelivery`, the atomic-send saga. Every
 * other way a coupon can reach someone announced nothing at all. A payment that
 * arrived over the ordinary NIP-17 gift-wrap path, which is how the merchant
 * flows and the legacy bridge deliver, was silently redeemed: the balance moved
 * and a row appeared in history, but nothing on screen said so. That is the
 * "valverde got no toast for simon's 4 FCFA" report, and no amount of fixing the
 * queue would have produced one, because no envelope was ever enqueued.
 *
 * So settlement announces itself, from dm-poll's redemption path, where the
 * money demonstrably landed. This is the complement of the advance notice, not a
 * replacement:
 *
 *   - advance notice ("on its way") is optimistic, may never be followed by
 *     settlement, and is best-effort by design.
 *   - this one ("received") is the truth, and fires for every arrival however it
 *     was delivered.
 *
 * When both fire for the same payment the user sees the pending toast and then
 * the confirmation, which is the intended pair. When only one can fire — the
 * common case for non-atomic-send deliveries — it is this one, which is the
 * important half.
 *
 * De-duplicated on the voucher id, because dm-poll can legitimately process the
 * same gift wrap twice (an SSE reconnect re-queries a window it already saw) and
 * a second announcement of one payment reads as a second payment.
 */

/** Voucher ids already announced. Bounded; see incomingNotifications for why. */
const announced = new Set<string>()
const ANNOUNCED_LIMIT = 200

export interface ArrivedVoucher {
  voucher_id?: string
  face_value?: number
  face_unit?: string
  face_decimals?: number
  sender_pubkey?: string
  memo?: string
}

/**
 * Announce an arrival. Safe to call for anything dm-poll redeemed; it decides
 * whether there is something worth showing.
 *
 * Never throws. It is called from inside the redemption path, and a toast that
 * failed to render must not turn a successful redemption into a failed one —
 * that would burn the proofs and then report an error, which is the worst
 * outcome available here.
 */
export function announceArrival(voucher: ArrivedVoucher | undefined): void {
  try {
    if (!voucher) return

    // Keyed on the voucher id where there is one. Without it there is no stable
    // identity to dedupe on, and announcing is still better than silence — a
    // duplicate toast is a nuisance, a missed payment is the bug being fixed.
    const key = voucher.voucher_id
    if (key) {
      if (announced.has(key)) return
      announced.add(key)
      if (announced.size > ANNOUNCED_LIMIT) {
        // Sets iterate in insertion order, so this drops the oldest.
        const oldest = announced.values().next().value
        if (oldest !== undefined) announced.delete(oldest)
      }
    }

    /*
     * The currency decides the decimals, NOT the stored row.
     *
     * The gateway stamps `face_decimals: 2` on every currency regardless of unit
     * (§15.9 of the design spec). XAF is a zero-decimal currency, so the first
     * version of this toast announced a real 4 XAF coupon as "FCFA 0.04" while
     * the balance card beside it read "FCFA 4" — caught on staging, against a
     * genuinely-issued coupon whose row does carry `face_decimals: 2`.
     *
     * `currencyDecimals` is the wallet's existing answer to exactly this: it
     * asks Intl, which knows XAF and JPY take none, and falls back to 2 for a
     * merchant's own non-ISO unit. `issue.ts` already resolves the issuing side
     * this way for the same reason, so the two ends agree.
     *
     * The row's own value is the fallback rather than the source, and this is a
     * DISPLAY decision only: the minor-unit number is never scaled, because
     * backing is 1 sat per minor unit and rescaling it would over-back the token
     * a hundredfold and push it past the DM size limit.
     */
    const unit = voucher.face_unit ?? ''
    const decimals = unit ? currencyDecimals(unit) : (voucher.face_decimals ?? 0)
    const amount = formatFace(voucher.face_value ?? 0, { unit, decimals })

    toast.success(
      createElement(ReceivedPaymentToast, {
        pubkey: voucher.sender_pubkey,
        amount,
        memo: voucher.memo,
      }),
      {
        // Namespaced away from the pending toast's `pending-` ids so the two
        // never collapse onto each other: they are different statements about
        // the same payment and the user should see both.
        id: key ? 'received-' + key : undefined,
        // The tick is right here, unlike on the pending toast: the money has
        // landed. It comes from the Toaster's own success icon.
        duration: 6000,
      },
    )
  } catch (e) {
    console.warn('[arrival] could not announce a received coupon:', e)
  }
}

/** Test seam: forget what has been announced. */
export function resetAnnounced(): void {
  announced.clear()
}
