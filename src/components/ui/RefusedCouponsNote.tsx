import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { REFUSALS_CHANGED, refusalsFor, refusalSummary } from '../../lib/refusedCoupons'

/**
 * "1 of 2 coupons refused: <reason>", on the payment it happened to (#145).
 *
 * The toast that fires at refusal time is gone in seconds. This stays on the
 * payment's own screen so staff can still see that part of it was turned away
 * and ask the customer to pay the rest. Renders nothing when no coupon of the
 * payment was refused. Same amber strip as the other warnings in the app.
 */
export function RefusedCouponsNote({
  pubkey,
  bundleId,
  requestId,
  className = '',
}: {
  pubkey?: string
  bundleId?: string
  requestId?: string
  className?: string
}) {
  const read = () => refusalSummary(refusalsFor(pubkey ?? '', { bundleId, requestId }))
  const [summary, setSummary] = useState(read)

  useEffect(() => {
    const refresh = () => setSummary(read())
    refresh()
    // A refusal can land while this payment is on screen.
    window.addEventListener(REFUSALS_CHANGED, refresh)
    return () => window.removeEventListener(REFUSALS_CHANGED, refresh)
    // `read` closes over exactly these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, bundleId, requestId])

  if (!summary) return null

  return (
    <div
      role="status"
      className={`flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>
        {summary}. Nothing was taken for it, so ask the customer to pay the rest.
      </p>
    </div>
  )
}
