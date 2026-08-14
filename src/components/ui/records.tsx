import { Link } from 'react-router-dom'
import { ChevronRight, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import type { VoucherRow } from '@imani/wallet-storage'

import { formatFace, formatDate } from '../../lib/format'
import { counterpartyOf, transactionLabel, type WalletTransaction } from '../../lib/transactions'

/**
 * The two record rows, shared by the capped lists on the farmer screen and the
 * full lists behind "See all". One definition each, so a coupon looks the same
 * wherever it appears and only one file changes when it shouldn't.
 *
 * Both are minimal by intent: amount, one piece of context, a date. The detail
 * screen behind the row carries everything else.
 */

/** A coupon: face value, when it arrived. */
export function CouponListItem({ row }: { row: VoucherRow }) {
  return (
    <Link
      to={`/coupon/${encodeURIComponent(row.token_id)}`}
      className="flex items-center gap-3 p-4 transition-colors hover:bg-mono-100 dark:hover:bg-mono-900"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium text-mono-900 dark:text-mono-50">
          {formatFace(row.face_value ?? 0, { unit: row.face_unit ?? '', decimals: row.face_decimals ?? 0 })}
        </p>
        <p className="text-sm text-mono-500">{formatDate(row.created_at)}</p>
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
      className="flex items-center gap-3 p-4 transition-colors hover:bg-mono-100 dark:hover:bg-mono-900"
    >
      <Arrow className={`h-4 w-4 shrink-0 ${outgoing ? 'text-mono-500' : 'text-green-600'}`} />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-mono-900 dark:text-mono-50">{transactionLabel(tx)}</p>
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

/** Kept for the detail screens' hero line. */
export { counterpartyOf }
