import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { REFUSALS_CHANGED, refusalsFor, refusalSummary, type RefusedCoupon } from '../../lib/refusedCoupons'

/**
 * "1 of 2 coupons refused: <reason>", on the payment it happened to (#145).
 *
 * The toast that fires at refusal time is gone in seconds. This stays on the
 * payment's own screen so staff can still see that part of it was turned away
 * and ask the customer to pay the rest. Same amber strip as the other warnings
 * in the app. Renders nothing when no coupon of the payment was refused.
 *
 * **Only the payment's own payer is taken at their word.** The bundle and
 * request ids a refused coupon names are written by whoever sent it, so a
 * stranger can name somebody else's payment. A refusal from `payer` is stated
 * as part of this payment, with the instruction to collect the rest. Anyone
 * else's is worded neutrally, never as an instruction, and shown only while
 * the payment is still `pending`, when it might still be relevant.
 */
export function RefusedCouponsNote({
  pubkey,
  bundleId,
  requestId,
  payer,
  pending = false,
  className = '',
}: {
  pubkey?: string
  bundleId?: string
  requestId?: string
  /** The payment's own counterparty. Unknown means nobody is vouched for. */
  payer?: string
  /** The payment is still open, so an unvouched refusal may still matter. */
  pending?: boolean
  className?: string
}) {
  const read = () => refusalsFor(pubkey ?? '', { bundleId, requestId })
  const [refusals, setRefusals] = useState<RefusedCoupon[]>(read)

  useEffect(() => {
    const refresh = () => setRefusals(read())
    refresh()
    // A refusal can land while this payment is on screen.
    window.addEventListener(REFUSALS_CHANGED, refresh)
    return () => window.removeEventListener(REFUSALS_CHANGED, refresh)
    // `read` closes over exactly these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, bundleId, requestId])

  const payerKey = payer?.toLowerCase()
  const vouched = refusals.filter((r) => payerKey !== undefined && r.senderPubkey === payerKey)
  const unvouched = pending ? refusals.filter((r) => !vouched.includes(r)) : []

  const line = vouched.length > 0 ? vouchedLine(vouched) : unvouched.length > 0 ? unvouchedLine(unvouched) : undefined
  if (!line) return null

  return (
    <div
      role="status"
      className={`flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>{line}</p>
    </div>
  )
}

/** The payer's own refused coupons: what happened, and what to do about it. */
function vouchedLine(refusals: readonly RefusedCoupon[]): string {
  const pronoun = refusals.length > 1 ? 'them' : 'it'
  return `${refusalSummary(refusals)}. Nothing was taken for ${pronoun}, so ask the customer to pay the rest.`
}

/** Someone else's: a fact, not an instruction, and no count that implies a shortfall. */
function unvouchedLine(refusals: readonly RefusedCoupon[]): string {
  return refusals.length > 1
    ? `${refusals.length} coupons naming this payment were refused. Nothing was taken for them.`
    : 'A coupon naming this payment was refused. Nothing was taken for it.'
}
