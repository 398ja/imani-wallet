import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Clock, X } from 'lucide-react'
import type { VoucherRow } from '@imani/wallet-storage'

import { bannerState, dismissBanner } from '../../lib/expiryReminders'
import { useExpiryClock } from '../../hooks/useExpiryReminders'

/**
 * "2 vouchers expire this week", on home (#265).
 *
 * Information, not a gate: one line, tappable to the expiring list, with its own dismiss button.
 * Dismissed, it stays away until a coupon crosses a NEW threshold (`bannerState`), so a customer
 * who said "I know" is not nagged on every open, and is still told when something new happens.
 * Honours the "Coupons about to expire" switch.
 *
 * `role="status"`, not `alert`: nothing the user did caused it, and it must not interrupt a
 * screen reader mid-sentence.
 */
export function ExpiryBanner({ pubkey, rows, now }: { pubkey: string; rows: VoucherRow[]; now?: number }) {
  const [, setTick] = useState(0)
  // Re-read on the hour and on return, so a banner left on screen picks up a coupon entering its
  // last day.
  useExpiryClock()

  const state = bannerState(pubkey, rows, now)
  if (!state.show) return null

  return (
    <div
      role="status"
      className="mb-6 flex items-center gap-2 rounded-2xl bg-amber-50 p-1 pl-4 text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-800"
    >
      <Clock className="h-5 w-5 shrink-0" aria-hidden="true" />
      <Link to="/coupons/expiring" className="pressable min-w-0 flex-1 py-2.5 text-sm font-medium underline-offset-2 hover:underline">
        {state.text}
      </Link>
      <button
        type="button"
        onClick={() => {
          dismissBanner(pubkey, rows, now)
          setTick((t) => t + 1)
        }}
        aria-label="Dismiss"
        className="pressable flex h-11 w-11 shrink-0 items-center justify-center rounded-full outline-none ring-amber-500 focus-visible:ring-2"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}
