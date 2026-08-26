import { Link } from 'react-router-dom'
import { ChevronRight, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import type { VoucherRow } from '@imani/wallet-storage'

import { formatFace, formatDate, displayDecimals } from '../../lib/format'
import { isRedeemed } from '../../lib/merchants'
import { transactionLabel, type WalletTransaction } from '../../lib/transactions'
import { hasValidationClaim } from '../../lib/validationStatus'
import { ValidationBadge } from './ValidationBadge'

/**
 * The two record rows, shared by the capped lists on the merchant screen and the
 * full lists behind "See all". One definition each, so a coupon looks the same
 * wherever it appears and only one file changes when it shouldn't.
 *
 * Both are minimal by intent: amount, one piece of context, a date. The detail
 * screen behind the row carries everything else.
 */

/**
 * A coupon: face value, when it arrived.
 *
 * A redeemed one is dimmed and says so. It is a receipt, not money — the value
 * behind it was burnt when it came back (burn.ts) — and one row that looks like
 * every other is exactly how a used coupon gets handed out a second time.
 */
export function CouponListItem({ row }: { row: VoucherRow }) {
  const redeemed = isRedeemed(row)
  return (
    <Link
      to={`/coupon/${encodeURIComponent(row.token_id)}`}
      className={`flex items-center gap-3 p-4 press-row ${
        redeemed ? 'opacity-60' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <p
          className={
            redeemed
              ? 'font-medium text-mono-500 line-through'
              : 'font-medium text-mono-900 dark:text-mono-50'
          }
        >
          {formatFace(row.face_value ?? 0, {
            unit: row.face_unit ?? '',
            // Currency first, stored row second: pre-DEV-238 rows say 2 for XAF.
            decimals: displayDecimals(row.face_unit, row.face_decimals),
          })}
        </p>
        <p className="text-sm text-mono-500">
          {redeemed ? 'Redeemed · ' : ''}
          {formatDate(row.created_at)}
        </p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )
}

/**
 * A transaction: which way the money went, with whom, when.
 *
 * The arrow follows `tx.direction`, which `toTransaction` derives from the type
 * — the stored `direction` field is hardcoded 'in' by the writer and would point
 * the wrong way on every payment.
 */
export function TransactionListItem({ tx }: { tx: WalletTransaction }) {
  const outgoing = tx.direction === 'out'
  const Arrow = outgoing ? ArrowUpRight : ArrowDownLeft

  return (
    <Link
      to={`/transaction/${encodeURIComponent(tx.id)}`}
      className="flex items-center gap-3 p-4 press-row"
    >
      <Arrow className={`h-4 w-4 shrink-0 ${outgoing ? 'text-mono-500' : 'text-green-600'}`} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-medium text-mono-900 dark:text-mono-50">
          <span className="truncate">{transactionLabel(tx)}</span>
          {/*
            Beside the type, not beside the amount. The amount is what the eye
            lands on first and it must stay uncluttered; the badge qualifies
            WHAT this row is, so it belongs with the label that says so.

            Only where there is a claim to check — see hasValidationClaim. A
            mark on every outgoing payment would be noise, and noise is how a
            signal that matters gets ignored.
          */}
          {hasValidationClaim(tx) ? <ValidationBadge validation={tx.validation} /> : null}
        </p>
        <p className="truncate text-sm text-mono-500">
          {formatDate(tx.at)}
          {tx.memo ? ` · ${tx.memo}` : ''}
        </p>
      </div>
      <p className="shrink-0 text-right text-mono-900 dark:text-mono-50">
        {outgoing ? '−' : '+'}
        {formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })}
      </p>
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )
}
