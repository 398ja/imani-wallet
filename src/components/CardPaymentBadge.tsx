import { RotateCcw, ShieldAlert } from 'lucide-react'

import {
  cardPaymentExplanation,
  cardPaymentLabel,
  cardPaymentMerchantNote,
  isReversed,
  type CardPaymentState,
} from '../lib/cardPaymentState'
import { formatDate } from '../lib/format'

/**
 * "Refunded" / "Partly refunded £x of £y" / "Disputed" on a card voucher (imani-wallet#277).
 *
 * Text and an icon, never colour alone: amber (a caution about the payment, not an accusation of
 * the holder), its own glyph per state, and the date the refund or dispute was recorded. The
 * badge is `role="status"` with the whole sentence as its accessible name, so a screen reader
 * hears what it means rather than "image".
 */
export function CardPaymentBadge({
  state,
  money,
  className = '',
}: {
  state: CardPaymentState | undefined
  money: (minor: number) => string
  className?: string
}) {
  if (!isReversed(state)) return null
  const Icon = state.status === 'disputed' ? ShieldAlert : RotateCcw
  const label = cardPaymentLabel(state, money)
  const date = state.reversedAt ? formatDate(state.reversedAt) : ''
  const spoken = date ? `${label}, ${date}` : label
  return (
    <span
      role="status"
      aria-label={spoken}
      data-testid="card-payment-badge"
      data-state={state.status}
      className={`inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-300 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-800 ${className}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{label}</span>
      {date ? <span className="font-normal">· {date}</span> : null}
    </span>
  )
}

/** The callout on a holder's voucher detail: the badge plus "Can't be spent: payment refunded". */
export function CardPaymentNotice({
  state,
  money,
  audience,
}: {
  state: CardPaymentState | undefined
  money: (minor: number) => string
  audience: 'holder' | 'stall'
}) {
  if (!isReversed(state)) return null
  const text = audience === 'holder' ? cardPaymentExplanation(state, money) : cardPaymentMerchantNote(state, money)
  return (
    <div
      data-testid="card-payment-notice"
      className="mb-6 flex flex-col gap-2 rounded-2xl bg-amber-50 p-4 text-[15px] leading-snug text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-950/50 dark:text-amber-200 dark:ring-amber-800"
    >
      <CardPaymentBadge state={state} money={money} className="self-start" />
      <p>{text}</p>
    </div>
  )
}
