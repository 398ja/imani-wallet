import { toast } from 'sonner'
import type { HoldReason } from '@imani/dm-poll'

/**
 * The toast for a coupon the trusted-mint gate is holding (#133 review).
 *
 * Its own module, like `refusalToast`, because `sonner` touches the DOM at import
 * and the poller is imported by suites that run headless. The record itself is in
 * `heldCoupons.ts`, which stays free of it.
 */

/**
 * A short toast the first time a coupon is held, so the person at the counter
 * knows it arrived. Never throws.
 */
export function announceHeld(event: { reason?: HoldReason } | undefined): void {
  try {
    if (!event?.reason) return
    toast.warning('Coupon waiting to be verified', {
      description:
        event.reason === 'no-trusted-mint'
          ? 'This wallet does not yet know which market holds coupon value. It will arrive once that is confirmed. Nothing was taken.'
          : 'Its value is held somewhere this wallet has not confirmed. It stays here and arrives if that is confirmed. Nothing was taken.',
      duration: 10_000,
    })
  } catch (e) {
    console.warn('[held] could not announce a held coupon:', e)
  }
}
