import { CheckCircle2, HelpCircle, AlertTriangle } from 'lucide-react'

import {
  VALIDATION_SUMMARY,
  validationStatus,
  type ValidationStatus,
} from '../../lib/validationStatus'
import type { VoucherValidation } from '../../lib/voucherToken'

/**
 * The check result, as one small mark on a list row.
 *
 * **Colour is never the only signal.** Each state has its own GLYPH — tick,
 * question mark, warning triangle — so the badge still reads for the ~8% of men
 * with a colour vision deficiency, in bright sun at a market stall, and in a
 * screenshot printed in greyscale. Colour is the fast path, shape is the fact.
 *
 * Sized to the row's text rather than to a fixed pixel value, so it grows with
 * the user's Dynamic Type setting instead of shrinking into insignificance at
 * large text sizes.
 *
 * Muted rather than saturated for `unchecked`: most older rows are unchecked,
 * and an amber dot on all of them would be an alarm that means nothing. Amber is
 * reserved for the state that is genuinely indeterminate, and it earns attention
 * by being rarer than green.
 */
const STYLE: Record<ValidationStatus, { Icon: typeof CheckCircle2; className: string }> = {
  // Green-600: the same green the app already uses for incoming value, so a
  // verified coupon and money arriving speak with one voice.
  verified: { Icon: CheckCircle2, className: 'text-green-600' },
  // Deliberately grey, not amber. "Not checked" is the resting state of every
  // row written before verification existed; painting those a warning colour
  // would cry wolf on the wallet's own history.
  //
  // mono-500, not the quieter mono-400: measured against the list background,
  // mono-400 is 2.52:1, under the 3:1 WCAG minimum for a non-text graphic that
  // carries meaning. mono-500 is 4.74:1 and still reads as the calm option
  // beside green-600 (3.30:1) and red-500 (3.76:1).
  unchecked: { Icon: HelpCircle, className: 'text-mono-500' },
  // Red-500 matches the error icon in the toast stack.
  failed: { Icon: AlertTriangle, className: 'text-red-500' },
}

/**
 * @param validation what the wallet recorded, or `undefined` for an unchecked row
 * @param className extra layout classes from the caller (never colour)
 */
export function ValidationBadge({
  validation,
  className = '',
}: {
  validation?: VoucherValidation
  className?: string
}) {
  const status = validationStatus(validation)
  const { Icon, className: tone } = STYLE[status]
  const summary = VALIDATION_SUMMARY[status]

  return (
    <Icon
      // 1em, so it tracks the surrounding text size rather than fighting it.
      className={`h-[1em] w-[1em] shrink-0 ${tone} ${className}`}
      // Named for a screen reader, and titled for a pointer — the same fact
      // reaching two different ways of asking for it.
      role="img"
      aria-label={summary}
    >
      <title>{summary}</title>
    </Icon>
  )
}
