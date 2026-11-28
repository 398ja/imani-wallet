import { useId, useState } from 'react'
import { CalendarClock } from 'lucide-react'

import { Button } from './ui'
import {
  CONSENT_LINE,
  PLAN_TERMS,
  formatMoney,
  planSummary,
  termLabel,
  type PlanTerm,
  type StartRefusal,
} from '../lib/instalments'

/**
 * The "Pay monthly" half of the Buy page (monthly payments spec, "Customer: starting").
 *
 * Amount each month, how long, a live summary that does the arithmetic, one consent line that
 * is always visible, and the button. Everything the screen cannot decide by itself (the
 * minimum, whether the stall's account can take plans) comes from payment-adapter's refusal and
 * is shown under the button, wired to it with `aria-describedby`, exactly as Buy does.
 *
 * Presentational: the parent owns the network and the stall checks, so this can be reasoned
 * about, and tested, without either.
 */
export function MonthlyPaymentForm({
  currency,
  unavailable,
  refusal,
  busy,
  onStart,
}: {
  /** The stall's currency, for the summary. */
  currency: string
  /** Why the button cannot be pressed right now (readiness, stall closed), or null. */
  unavailable: string | null
  /** The adapter's last refusal, or null. */
  refusal: StartRefusal | null
  busy: boolean
  onStart: (amountMinor: number, term: PlanTerm) => void
}) {
  const [amount, setAmount] = useState('')
  const [term, setTerm] = useState<PlanTerm>(6)
  const reasonId = useId()
  const hintId = useId()
  const amountId = useId()

  const minor = toMinorUnits(amount)
  // Only complain about what cannot become valid by typing more (the Buy page's rule).
  const malformed = amount.trim() !== '' && minor === null && !/^\d*\.?\d{0,2}$/.test(amount.trim())
  // Once the adapter has named its minimum, an amount under it is refused here too, before the tap.
  const minimum = refusal?.kind === 'below-minimum' ? refusal.minAmountMinor : null
  const belowMinimum = minimum !== null && minor !== null && minor < minimum

  const reason =
    unavailable ??
    (refusal === null
      ? null
      : refusal.kind === 'below-minimum'
        ? minimum !== null
          ? `Monthly payments start at ${formatMoney(minimum, currency)}.`
          : refusal.reason
        : refusal.reason)
  // A below-minimum refusal stops mattering once the amount is raised past it.
  const showReason = reason !== null
    && !(refusal?.kind === 'below-minimum' && minimum !== null && minor !== null && !belowMinimum && unavailable === null)
  const disabled = minor === null || belowMinimum || unavailable !== null || busy
    || refusal?.kind === 'not-offered' || refusal?.kind === 'not-eligible'

  return (
    <div>
      <label className="mb-2 block text-sm font-medium" htmlFor={amountId}>
        Amount each month
      </label>
      <input
        id={amountId}
        inputMode="decimal"
        autoComplete="off"
        className="mb-2 w-full rounded-xl border border-mono-200 bg-transparent px-4 py-3 text-lg tabular-nums outline-none transition-colors duration-100 ease-out placeholder:text-mono-400 focus:border-mono-400 dark:border-mono-800 dark:focus:border-mono-600"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="40.00"
        aria-describedby={malformed ? hintId : undefined}
        aria-invalid={malformed || belowMinimum || undefined}
      />
      {malformed && (
        <p id={hintId} className="mb-2 text-sm text-mono-500">
          Enter an amount like 40.00.
        </p>
      )}

      <fieldset className="mb-4 mt-2">
        <legend className="mb-2 block text-sm font-medium">How long</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How long">
          {PLAN_TERMS.map((t) => (
            <button
              key={String(t)}
              type="button"
              role="radio"
              aria-checked={term === t}
              onClick={() => setTerm(t)}
              className={`pressable rounded-full border px-4 py-2 text-sm transition-colors duration-100 ${
                term === t
                  ? 'border-mono-900 bg-mono-900 text-white dark:border-mono-50 dark:bg-mono-50 dark:text-mono-900'
                  : 'border-mono-200 dark:border-mono-800'
              }`}
            >
              {termLabel(t)}
            </button>
          ))}
        </div>
      </fieldset>

      {minor !== null && (
        <p className="mb-3 text-callout leading-relaxed" aria-live="polite">
          {planSummary(minor, currency, term)}
        </p>
      )}

      <p className="mb-2 text-sm text-mono-500">{CONSENT_LINE}</p>

      <Button
        size="lg"
        className="mt-2 w-full"
        disabled={disabled}
        aria-describedby={showReason ? reasonId : undefined}
        onClick={() => minor !== null && onStart(minor, term)}
      >
        <CalendarClock className="mr-2 h-5 w-5" aria-hidden /> Start monthly payments
      </Button>
      {showReason && (
        <p id={reasonId} className="mt-2 text-center text-xs text-mono-600 dark:text-mono-400">
          {reason}
        </p>
      )}
    </div>
  )
}

/** Same rule as the one-off amount: reject rather than round. */
export function toMinorUnits(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const minor = Math.round(Number(trimmed) * 100)
  return Number.isFinite(minor) && minor > 0 ? minor : null
}
