import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'

import { HELD_CHANGED, heldCoupons, heldSummary, type HeldCoupon } from '../../lib/heldCoupons'
import { pendingCashbackCount } from '../../lib/cashback'

/**
 * "2 coupons are waiting to be verified", shown on every screen while any are
 * (imani-wallet#133 review, MEDIUM-2).
 *
 * The trusted-mint gate HOLDS a coupon whose mint it cannot confirm: nothing is
 * swapped and nothing is lost, and the coupon arrives on its own once the mint is
 * confirmed. Before this strip the wait was invisible, so a held coupon looked
 * exactly like one lost in the network. Counts held DM coupons and claimed
 * cashback still waiting on this device. Renders nothing when none are waiting.
 */
export function HeldCouponsNotice({ pubkey, className = '' }: { pubkey?: string; className?: string }) {
  const read = () => ({ held: heldCoupons(pubkey ?? ''), cashback: pendingCashbackCount() })
  const [state, setState] = useState<{ held: HeldCoupon[]; cashback: number }>(read)

  useEffect(() => {
    const refresh = () => setState(read())
    refresh()
    window.addEventListener(HELD_CHANGED, refresh)
    // Cashback is stashed by a screen, not by the poller; re-read on focus.
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener(HELD_CHANGED, refresh)
      window.removeEventListener('focus', refresh)
    }
    // `read` closes over exactly this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey])

  const line = heldSummary(state.held, state.cashback)
  if (!line) return null

  return (
    <div className={`px-4 ${className}`}>
      <div
        role="status"
        className="mx-auto flex max-w-lg gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
      >
        <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>{line}</p>
      </div>
    </div>
  )
}
