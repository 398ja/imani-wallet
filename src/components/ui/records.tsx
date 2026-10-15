import { Link } from 'react-router-dom'
import { ChevronDown, ChevronRight, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import type { VoucherRow } from '@imani/wallet-storage'

import { vouchers } from '../../lib/bundleWording'
import { formatFace, formatDate, displayDecimals } from '../../lib/format'
import { worstValidation, type HistoryEntry } from '../../lib/historyGroups'
import { isRedeemed } from '../../lib/merchants'
import { expiryState } from '../../lib/couponExpiry'
import { ExpiryBadge } from './ExpiryBadge'
import { giftStatusLabel, transactionLabel, type WalletTransaction } from '../../lib/transactions'
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
 *
 * An expired one (#265) is dimmed the same way and says when it ran out, in place of when it
 * arrived: that is the date that explains why it no longer counts. A live one inside a week of
 * its expiry carries the badge beside its value.
 *
 * `now` is a seam for tests; screens pass nothing.
 */
export function CouponListItem({ row, now }: { row: VoucherRow; now?: number }) {
  const redeemed = isRedeemed(row)
  const expiry = expiryState(row, now)
  const expired = !redeemed && expiry.kind === 'expired'
  const dimmed = redeemed || expired
  return (
    <Link
      to={`/coupon/${encodeURIComponent(row.token_id)}`}
      className={`flex items-center gap-3 p-4 press-row ${
        dimmed ? 'opacity-60' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={
              redeemed
                ? 'font-medium text-mono-500 line-through'
                : expired
                  ? 'font-medium text-mono-500'
                  : 'font-medium text-mono-900 dark:text-mono-50'
            }
          >
            {formatFace(row.face_value ?? 0, {
              unit: row.face_unit ?? '',
              // Currency first, stored row second: pre-DEV-238 rows say 2 for XAF.
              decimals: displayDecimals(row.face_unit, row.face_decimals),
            })}
          </span>
          {!redeemed && <ExpiryBadge state={expiry} />}
        </p>
        <p className="text-sm text-mono-500">
          {redeemed ? 'Redeemed · ' : ''}
          {expired && expiry.kind === 'expired' ? `Expired ${expiry.dateText}` : formatDate(row.created_at)}
        </p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )
}

/**
 * A history entry: one transaction, or one payment made of several vouchers
 * (#106), which folds its rows under a single line.
 *
 * The folded line's figure is the SUM OF ITS ROWS, never anything the sender
 * declared, and opening it shows those rows, each linking to its own detail
 * screen as before. A plain `<details>` rather than state, for the reasons
 * Header.tsx gives: it is keyboard-operable and needs no effect to be right.
 */
export function HistoryListItem({ entry }: { entry: HistoryEntry }) {
  if (entry.kind === 'single') return <TransactionListItem tx={entry.tx} />

  const outgoing = entry.direction === 'out'
  const Arrow = outgoing ? ArrowUpRight : ArrowDownLeft
  const label = transactionLabel(entry.parts[0]!)
  const total = formatFace(entry.amount, { unit: entry.unit, decimals: entry.decimals })
  const count = vouchers(entry.parts.length)
  const date = formatDate(entry.at)
  // Folding must not hide a failed check: the worst part's status rides on
  // the line (see worstValidation). And one payment has one memo, which the
  // sender wrote on every part; shown once, from whichever part carries it.
  const worst = worstValidation(entry.parts)
  const memo = entry.parts.find((p) => p.memo)?.memo

  return (
    <details className="group">
      {/*
        Laid out exactly like a single row — same arrow, same columns, same
        press tint, same inset focus ring the header controls use — so a
        payment reads as one payment whether it went as one
        voucher or three. Two things differ, and each says what this is: the
        count sits beside the label it qualifies (as the validation badge does
        on a single row), and the trailing chevron points DOWN, toward where the
        parts will appear, where a single row's points onward to a new screen.

        `tabular-nums` on the total so it lines up with the part amounts
        beneath it: the reader checks the sum by eye, and proportional digits
        make columns of money wobble.
      */}
      <summary
        aria-label={`${label}, ${outgoing ? 'minus' : 'plus'} ${total}, ${count}, ${date}`}
        className="flex cursor-pointer list-none items-center gap-3 p-4 outline-none ring-inset ring-mono-400 press-row focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
      >
        <Arrow className={`h-4 w-4 shrink-0 ${outgoing ? 'text-mono-500' : 'text-green-600'}`} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 font-medium text-mono-900 dark:text-mono-50">
            <span className="truncate">{label}</span>
            {/*
              Outlined, not filled. A filled chip in the row's own greys vanished
              into the hover and pressed tint (caught on a rendered screenshot);
              an inset hairline stays legible on every state of the row.
            */}
            <span className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums text-mono-600 ring-1 ring-inset ring-mono-300 dark:text-mono-300 dark:ring-mono-700">
              {count}
            </span>
            {worst !== undefined ? (
              <ValidationBadge validation={worst === 'none' ? undefined : worst} />
            ) : null}
          </p>
          <p className="truncate text-sm text-mono-500">
            {date}
            {memo ? ` · ${memo}` : ''}
          </p>
        </div>
        <p className="shrink-0 text-right tabular-nums text-mono-900 dark:text-mono-50">
          {outgoing ? '−' : '+'}
          {total}
        </p>
        {/*
          Rotates toward the opened content: the motion hints where the parts
          went. `transform` only, 200ms on the app's own curve; reduced motion
          keeps the end state and drops the turn.
        */}
        <ChevronDown
          aria-hidden
          className="h-4 w-4 shrink-0 text-mono-400 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      {/*
        The parts, nested INSIDE the payment rather than floated beside it: a
        tinted inset that shares the list's own dividers, so the eye reads them
        as belonging to the line above. They open out of that line (`expand-row`,
        a short slide and fade, already reduced to nothing under reduced motion)
        and each is the ordinary row, linking to its own detail screen.

        It closes instantly, which is asymmetric with the open (design §7). That
        is the same accepted trade the header menu documents: <details> cannot
        animate its own close, and a hand-rolled disclosure would give up the
        free keyboard, focus and Escape handling to buy 180ms of motion.
      */}
      <div className="expand-row divide-y divide-mono-200 border-t border-mono-200 bg-mono-50 pl-6 dark:divide-mono-800 dark:border-mono-800 dark:bg-mono-900/40">
        {entry.parts.map((tx) => (
          <TransactionListItem key={tx.id} tx={tx} />
        ))}
      </div>
    </details>
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
          {tx.link ? (
            <span className="shrink-0 rounded-full border border-mono-300 px-1.5 text-[11px] font-medium text-mono-500 dark:border-mono-600">
              By link
            </span>
          ) : null}
        </p>
        <p className="truncate text-sm text-mono-500">
          {formatDate(tx.at)}
          {tx.link ? ` · ${giftStatusLabel(tx.link)}` : ''}
          {tx.memo ? ` · ${tx.memo}` : ''}
        </p>
      </div>
      <p className="shrink-0 text-right tabular-nums text-mono-900 dark:text-mono-50">
        {outgoing ? '−' : '+'}
        {formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })}
      </p>
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )
}
