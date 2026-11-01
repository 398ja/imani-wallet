import { AlarmClock, Clock } from 'lucide-react'

import type { ExpiryState } from '../../lib/couponExpiry'
import { displayDecimals, formatFace } from '../../lib/format'

/**
 * "Expires in 3 days", as a small pill on a coupon row, a deck card or a merchant page (#265).
 *
 * **Never colour alone.** The words are always there, and each tone has its own glyph: a clock
 * for "this week" (amber) and an alarm clock for "the last day" (red). So the badge still reads in
 * greyscale, in bright sun at a stall, and for someone who cannot tell amber from red. The
 * accessible name carries the absolute date too, which the pill has no room for.
 *
 * Renders nothing beyond 7 days, for a coupon with no expiry, and for an expired one: the expired
 * state has its own group and its own words, and a pill saying "Expired" on a row inside the
 * "Expired" group would say it twice.
 *
 * `whitespace-normal`, not `truncate`: at large text sizes the pill wraps rather than cutting off
 * the number, which is the one part that matters.
 */
const TONE = {
  soon: {
    Icon: Clock,
    className:
      'bg-amber-50 text-amber-800 ring-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-800',
  },
  urgent: {
    Icon: AlarmClock,
    className: 'bg-red-50 text-red-700 ring-red-300 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-800',
  },
} as const

export function ExpiryBadge({ state, className = '' }: { state: ExpiryState; className?: string }) {
  if (state.kind !== 'live' || state.tone === 'calm') return null
  const { Icon, className: tone } = TONE[state.tone]
  return (
    <span
      role="img"
      aria-label={state.ariaLabel}
      title={state.ariaLabel}
      data-expiry-tone={state.tone}
      className={`inline-flex max-w-full items-center gap-1 whitespace-normal rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone} ${className}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span aria-hidden="true">{state.label}</span>
    </span>
  )
}

/**
 * The cue under a stall's card, on the home deck and the merchant page: the soonest coupon from
 * that stall inside the week, as "€2.50 · Expires in 3 days". Nothing when none is.
 */
export function StallExpiryCue({
  soonest,
  className = '',
}: {
  soonest: { row: { face_value?: number; face_unit?: string; face_decimals?: number }; state: ExpiryState } | undefined
  className?: string
}) {
  if (!soonest) return null
  const { row, state } = soonest
  const value = formatFace(row.face_value ?? 0, {
    unit: row.face_unit ?? '',
    decimals: displayDecimals(row.face_unit, row.face_decimals),
  })
  return (
    <p className={`mt-1 flex items-center justify-center gap-2 text-sm text-mono-600 dark:text-mono-300 ${className}`}>
      <span className="tabular-nums">{value}</span>
      <ExpiryBadge state={state} />
    </p>
  )
}
