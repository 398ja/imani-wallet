import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Ban,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  Gift,
  Hash,
  Hourglass,
  ShoppingBag,
  Undo2,
} from 'lucide-react'
import type { VoucherRow } from '@imani/wallet-storage'

import { vouchers } from '../../lib/bundleWording'
import { formatFace, formatDate, displayDecimals } from '../../lib/format'
import { entryVoucherCount, worstValidation, type HistoryEntry } from '../../lib/historyGroups'
import { isRedeemed } from '../../lib/merchants'
import { countdown, expiryState, type ExpiryState } from '../../lib/couponExpiry'
import {
  COPIED,
  COPY_ID,
  HIDE_DETAILS,
  NO_EXPIRY,
  SHOW_DETAILS,
  VOUCHER_FIELD,
  VOUCHER_SOURCE,
  VOUCHER_STATUS,
  expiredOn,
  expiredShort,
  voucherSourceKind,
  type VoucherSourceKind,
  type VoucherStatusKind,
} from '../../lib/voucherRowCopy'
import { voucherStatusKind } from '../../lib/voucherStatus'
import { ExpiryBadge } from './ExpiryBadge'
import { CardPaymentBadge } from '../CardPaymentBadge'
import { useHolderCardPaymentState } from '../../hooks/useCardPaymentState'
import { cardReferenceOfRow } from '../../lib/cardVoucherRef'
import { giftStatusLabel, transactionLabel, type WalletTransaction } from '../../lib/transactions'
import { hasValidationClaim } from '../../lib/validationStatus'
import { ValidationBadge } from './ValidationBadge'
import { CHECKOUT_CODE_TX_TYPE, CHECKOUT_STATUS_WORDS, checkoutFunds, type CheckoutCodeSnapshot } from '../../lib/checkoutCodeHistory'
import { useMerchantLabel } from '../../lib/identity'
import { spendSourceLabel } from '../../lib/spendSource'

/**
 * A checkout code (#402): what it is worth, the stall (named, never a key), the shop, when, and
 * where it stands. Opens the code screen, which reads the live record. The sign follows where the
 * value is: committed to the code or spent at the stall is out of the wallet; back is neither, so
 * the figure is shown without a sign and dimmed (the coupons it came back as are their own rows).
 */
function CheckoutCodeListItem({ tx, code }: { tx: WalletTransaction; code: CheckoutCodeSnapshot }) {
  const stall = useMerchantLabel({ pubkey: tx.merchantId ?? '', name: tx.merchantName })
  const funds = checkoutFunds(code)
  const words = CHECKOUT_STATUS_WORDS[code.status]
  const amount = formatFace(tx.amount, { unit: tx.unit, decimals: tx.decimals })
  return (
    <Link to={`/online/code/${encodeURIComponent(code.id)}`} className={`flex items-center gap-3 p-4 press-row ${funds === 'returned' ? 'opacity-60' : ''}`}>
      <ArrowUpRight className="h-4 w-4 shrink-0 text-mono-500" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 font-medium text-mono-900 dark:text-mono-50">
          <span className="truncate">{stall}</span>
          <span
            data-testid="checkout-status"
            className="shrink-0 rounded-full border border-mono-300 px-1.5 text-[11px] font-medium text-mono-500 dark:border-mono-600"
          >
            {words}
          </span>
        </p>
        <p className="truncate text-sm text-mono-500">
          Checkout code{code.shopHost ? ` · ${code.shopHost}` : ''} · {formatDate(tx.at)}
        </p>
      </div>
      <p className={`shrink-0 text-right tabular-nums text-mono-900 dark:text-mono-50 ${funds === 'returned' ? 'line-through' : ''}`}>
        {funds === 'returned' ? '' : '−'}
        {amount}
      </p>
      <ChevronRight className="h-4 w-4 shrink-0 text-mono-400" />
    </Link>
  )
}

/**
 * The two record rows, shared by the capped lists on the merchant screen and the
 * full lists behind "See all". One definition each, so a coupon looks the same
 * wherever it appears and only one file changes when it shouldn't.
 *
 * Both are minimal by intent: amount, one piece of context, a date. The detail
 * screen behind the row carries everything else.
 */

/**
 * A voucher: one row that opens in place (no detail screen since the voucher-rows change).
 *
 * Closed, it reads at a glance: the amount, large, with the expiry badge beside it, and one quiet
 * line under it (status for anything not ready to use, then the date that matters: when it ran
 * out for an expired one, when it arrived otherwise). Open, it lists everything a holder acts on:
 * status, received, expires, where it came from and the voucher id with a copy button. Nothing
 * else. The backing, ratio, issuance id, event id and the rest of the old screen are support
 * facts; they stay in the support snapshot (snapshot/build.ts) and are shown nowhere.
 *
 * A redeemed or expired voucher is dimmed and says so. It is a receipt, not money, and a row that
 * looks like every other is exactly how a used voucher gets handed out a second time (#265).
 *
 * Controlled from the list (`open`, `onToggle`) so a deep link can arrive with one row open; used
 * uncontrolled elsewhere. `now` is a seam for tests.
 */
export function CouponListItem({
  row,
  now,
  open: openProp,
  onToggle,
}: {
  row: VoucherRow
  now?: number
  open?: boolean
  onToggle?: (open: boolean) => void
}) {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = openProp ?? ownOpen
  const toggle = () => {
    if (openProp === undefined) setOwnOpen(!open)
    onToggle?.(!open)
  }
  const id = useId()
  const panelId = `voucher-${id}`
  const status = voucherStatusKind(row, now)
  const expiry = expiryState(row, now)
  const spent = status !== 'active' && status !== 'pending' && status !== 'expired' && status !== 'other'
  const expired = status === 'expired'
  const dimmed = status !== 'active' && status !== 'pending'
  // imani-wallet#277: the badge for a refunded or disputed card voucher.
  const cardPayment = useHolderCardPaymentState(isRedeemed(row) ? undefined : cardReferenceOfRow(row))
  const decimals = displayDecimals(row.face_unit, row.face_decimals)
  const money = (minor: number) => formatFace(minor, { unit: row.face_unit ?? '', decimals })
  const amount = money(row.face_value ?? 0)
  const dateLine =
    expired && expiry.kind === 'expired' ? expiredShort(expiry.dateText) : formatDate(row.created_at)

  return (
    <div data-voucher-row={row.token_id} className={open ? 'bg-mono-50/70 dark:bg-mono-900/40' : undefined}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
        className="flex min-h-16 w-full items-center gap-3 px-4 py-3.5 text-left outline-none ring-inset ring-mono-400 press-row focus-visible:ring-2"
      >
        <div className={`min-w-0 flex-1 ${dimmed ? 'opacity-60' : ''}`}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`text-[17px] font-semibold tabular-nums tracking-[-0.01em] ${
                spent ? 'text-mono-500 line-through' : expired ? 'text-mono-500' : 'text-mono-900 dark:text-mono-50'
              }`}
            >
              {amount}
            </span>
            {status === 'active' && <ExpiryBadge state={expiry} />}
            <CardPaymentBadge state={cardPayment} money={money} />
          </p>
          <p className="mt-0.5 truncate text-[13px] text-mono-500">
            {status !== 'active' && status !== 'expired' ? `${VOUCHER_STATUS[status]} · ` : ''}
            {dateLine}
          </p>
        </div>
        <span className="sr-only">{open ? HIDE_DETAILS : SHOW_DETAILS}</span>
        {/*
          Turns toward the content it reveals and back. A transition, not a keyframe: it reverses
          from wherever it is when the row is tapped again mid-turn.
        */}
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 shrink-0 text-mono-400 transition-transform duration-300 ease-spring motion-reduce:transition-none ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {/*
        Opens in place on a grid row going 0fr → 1fr, the content's own height with no measuring.
        A CSS transition rather than an animation, so a second tap mid-open reverses from where the
        panel is rather than jumping to an end (interruptible), on a critically damped spring curve
        (`ease-spring`). Under reduced motion it simply appears: no height change, no slide.
        Closed, the panel is `inert`: out of the tab order and the accessibility tree.
      */}
      <div
        id={panelId}
        role="region"
        aria-label={amount}
        inert={!open}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-spring motion-reduce:transition-none ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <VoucherFacts row={row} status={status} expiry={expiry} />
        </div>
      </div>
    </div>
  )
}

const STATUS_TONE: Record<VoucherStatusKind, { Icon: typeof CircleCheck; className: string }> = {
  active: { Icon: CircleCheck, className: 'bg-green-50 text-green-800 ring-green-300 dark:bg-green-950/50 dark:text-green-300 dark:ring-green-800' },
  pending: { Icon: Hourglass, className: 'bg-sky-50 text-sky-800 ring-sky-300 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-800' },
  expired: { Icon: CalendarX, className: 'bg-mono-100 text-mono-700 ring-mono-300 dark:bg-mono-900 dark:text-mono-300 dark:ring-mono-700' },
  spent: { Icon: CheckCheck, className: 'bg-mono-100 text-mono-700 ring-mono-300 dark:bg-mono-900 dark:text-mono-300 dark:ring-mono-700' },
  redeemed: { Icon: CheckCheck, className: 'bg-mono-100 text-mono-700 ring-mono-300 dark:bg-mono-900 dark:text-mono-300 dark:ring-mono-700' },
  swapped: { Icon: Undo2, className: 'bg-mono-100 text-mono-700 ring-mono-300 dark:bg-mono-900 dark:text-mono-300 dark:ring-mono-700' },
  refused: { Icon: Ban, className: 'bg-mono-100 text-mono-700 ring-mono-300 dark:bg-mono-900 dark:text-mono-300 dark:ring-mono-700' },
  other: { Icon: Ban, className: 'bg-mono-100 text-mono-700 ring-mono-300 dark:bg-mono-900 dark:text-mono-300 dark:ring-mono-700' },
}

const SOURCE_ICON: Record<VoucherSourceKind, typeof Gift> = {
  cashlink: Gift,
  returned: Undo2,
  bought: ShoppingBag,
  recovered: Undo2,
  received: ArrowDownLeft,
}

/** The status pill: words always, a glyph per state, colour last (never colour alone). */
export function VoucherStatusBadge({ status }: { status: VoucherStatusKind }) {
  const { Icon, className } = STATUS_TONE[status]
  return (
    <span
      data-voucher-status={status}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${className}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {VOUCHER_STATUS[status]}
    </span>
  )
}

/** The opened row's facts: an icon, a label, a value. Status first, the id last. */
function VoucherFacts({ row, status, expiry }: { row: VoucherRow; status: VoucherStatusKind; expiry: ExpiryState }) {
  const SourceIcon = SOURCE_ICON[voucherSourceKind(row.source_transport)]
  // A countdown only for a voucher that can still be spent: a spent one's expiry is history.
  const counting = status === 'active' || status === 'pending'
  const expires =
    expiry.kind === 'live'
      ? counting
        ? `${expiry.dateText} · ${countdown(expiry.msLeft)}`
        : expiry.dateText
      : expiry.kind === 'expired'
        ? expiredOn(expiry.dateText)
        : NO_EXPIRY
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 px-4 pb-4 pt-0.5 text-sm">
      <Fact icon={CircleCheck} label={VOUCHER_FIELD.status}>
        <VoucherStatusBadge status={status} />
      </Fact>
      <Fact icon={CalendarPlus} label={VOUCHER_FIELD.received}>
        {formatDate(row.created_at)}
      </Fact>
      <Fact icon={expiry.kind === 'expired' ? CalendarX : CalendarClock} label={VOUCHER_FIELD.expires}>
        {expires}
      </Fact>
      <Fact icon={SourceIcon} label={VOUCHER_FIELD.source}>
        {VOUCHER_SOURCE[voucherSourceKind(row.source_transport)]}
      </Fact>
      <Fact icon={Hash} label={VOUCHER_FIELD.id}>
        <VoucherId id={row.token_id} />
      </Fact>
    </dl>
  )
}

function Fact({ icon: Icon, label, children }: { icon: typeof Hash; label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-2 text-[13px] text-mono-500">
        <Icon className="h-4 w-4 shrink-0 text-mono-400" aria-hidden="true" />
        {label}
      </dt>
      <dd className="flex min-w-0 justify-end text-right tabular-nums text-mono-800 dark:text-mono-200">{children}</dd>
    </>
  )
}

/**
 * The id, truncated in the middle's place (the end, with an ellipsis, in monospace so it never
 * reflows) and copied whole. The full id is the button's title and the copy, never lost to the
 * ellipsis. A 44px target by padding, not by a bigger glyph.
 */
function VoucherId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
    } catch {
      // No clipboard (an insecure origin, a refused permission): the id stays selectable.
    }
  }
  return (
    <span className="flex min-w-0 items-center justify-end gap-1">
      <span title={id} className="min-w-0 truncate font-mono text-[13px] text-mono-700 select-all dark:text-mono-300">
        {id}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={COPY_ID}
        className="pressable -my-2.5 -mr-2.5 shrink-0 rounded-full p-2.5 text-mono-400 outline-none ring-mono-400 hover:text-mono-600 focus-visible:ring-2 dark:hover:text-mono-300"
      >
        {copied ? <Check className="h-4 w-4 text-green-600" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? COPIED : ''}
      </span>
    </span>
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
  const count = vouchers(entryVoucherCount(entry))
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
  if (tx.type === CHECKOUT_CODE_TX_TYPE && tx.checkoutCode) return <CheckoutCodeListItem tx={tx} code={tx.checkoutCode} />
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
              Cashlink
            </span>
          ) : null}
          {tx.spendSource ? (
            <span className="shrink-0 rounded-full border border-mono-300 px-1.5 text-[11px] font-medium text-mono-500 dark:border-mono-600">
              Online
            </span>
          ) : null}
        </p>
        <p className="truncate text-sm text-mono-500">
          {formatDate(tx.at)}
          {tx.link ? ` · ${giftStatusLabel(tx.link)}` : ''}
          {/* #402 traceability: which shop order spent it, before the memo the shop did not write. */}
          {tx.spendSource ? ` · ${spendSourceLabel(tx.spendSource)}` : tx.memo ? ` · ${tx.memo}` : ''}
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
