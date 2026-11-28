import { useId, useState } from 'react'
import { CalendarClock } from 'lucide-react'

import { Button } from './ui'
import {
  ADVERB,
  CONSENT_LINE,
  eachPeriod,
  formatMoney,
  isMonthlyOnly,
  paymentsNoun,
  planSummary,
  planTerms,
  presetTerm,
  termLabel,
  type PlanInterval,
  type PlanTerm,
  type StartRefusal,
} from '../lib/instalments'

/**
 * The "Pay monthly" (or "Pay over time") half of the Buy page (monthly payments spec,
 * "Customer: starting").
 *
 * How often (only when the stall offers more than one interval), the amount each time, how long,
 * a live summary that does the arithmetic, one consent line that is always visible, and the
 * button. Everything the screen cannot decide by itself (the minimum, whether the stall's account
 * can take plans) comes from payment-adapter's refusal and is shown under the button, wired to it
 * with `aria-describedby`, exactly as Buy does.
 *
 * A stall that offers monthly only sees exactly the form it always had: no frequency choice, and
 * the monthly words.
 *
 * Presentational: the parent owns the network and the stall checks, so this can be reasoned
 * about, and tested, without either.
 */
export function MonthlyPaymentForm({
  currency,
  intervals = ['month'],
  unavailable,
  refusal,
  busy,
  onStart,
}: {
  /** The stall's currency, for the summary. */
  currency: string
  /** What the stall offers, in the chooser's order. Never empty in practice; empty reads as monthly. */
  intervals?: readonly PlanInterval[]
  /** Why the button cannot be pressed right now (readiness, stall closed), or null. */
  unavailable: string | null
  /** The adapter's last refusal, or null. */
  refusal: StartRefusal | null
  busy: boolean
  onStart: (amountMinor: number, term: PlanTerm, interval: PlanInterval) => void
}) {
  const offered: readonly PlanInterval[] = intervals.length > 0 ? intervals : ['month']
  // Monthly first when it is offered: it is what a buyer expects, and what every stall had before.
  const [interval, setIntervalState] = useState<PlanInterval>(offered.includes('month') ? 'month' : offered[0])
  const [amount, setAmount] = useState('')
  // The term together with the interval it was chosen for: "12" chosen as 12 weeks must never be
  // read as 12 months when the interval changes under it (the stall narrowed its offer).
  const [chosen, setChosen] = useState<{ interval: PlanInterval; term: PlanTerm }>({ interval, term: presetTerm(interval) })
  const reasonId = useId()
  const hintId = useId()
  const amountId = useId()

  // The stall's offer changed under the form (a refusal named what it takes now): never keep a
  // choice it no longer offers, which would be refused again on the next tap.
  const current: PlanInterval = offered.includes(interval) ? interval : offered.includes('month') ? 'month' : offered[0]
  const terms = planTerms(current)
  const currentTerm: PlanTerm =
    chosen.interval === current && terms.includes(chosen.term) ? chosen.term : presetTerm(current)

  const chooseInterval = (next: PlanInterval) => {
    if (next === current) return
    setIntervalState(next)
    // The chips are different per interval ("8 weeks" is not "8 months"), so start from its preset.
    setChosen({ interval: next, term: presetTerm(next) })
  }

  const minor = toMinorUnits(amount)
  // Only complain about what cannot become valid by typing more (the Buy page's rule).
  const malformed = amount.trim() !== '' && minor === null && !/^\d*\.?\d{0,2}$/.test(amount.trim())
  // Once the adapter has named its minimum, an amount under it is refused here too, before the tap.
  const minimum = refusal?.kind === 'below-minimum' ? refusal.minAmountMinor : null
  const belowMinimum = minimum !== null && minor !== null && minor < minimum
  const monthlyOnly = isMonthlyOnly(offered)
  const noun = paymentsNoun(offered)

  // An interval refusal says what the stall takes now ("Choose again"). The parent narrows the
  // choice to those, so the form has already moved off the refused one; the button is only held
  // while the picked interval is still one the stall refused.
  const intervalRefused = refusal?.kind === 'interval-not-offered' && !refusal.intervals.includes(current)
  const reason =
    unavailable ??
    (refusal === null
      ? null
      : refusal.kind === 'below-minimum'
        ? minimum !== null
          ? `${noun.charAt(0).toUpperCase()}${noun.slice(1)} start at ${formatMoney(minimum, currency)}.`
          : refusal.reason
        : refusal.reason)
  // A below-minimum refusal stops mattering once the amount is raised past it.
  const showReason = reason !== null
    && !(refusal?.kind === 'below-minimum' && minimum !== null && minor !== null && !belowMinimum && unavailable === null)
  const disabled = minor === null || belowMinimum || unavailable !== null || busy
    || refusal?.kind === 'not-offered' || refusal?.kind === 'not-eligible' || intervalRefused

  return (
    <div>
      {offered.length > 1 && (
        <fieldset className="mb-4">
          <legend className="mb-2 block text-sm font-medium">How often</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How often">
            {offered.map((i) => (
              <Chip key={i} checked={current === i} onClick={() => chooseInterval(i)}>
                {ADVERB[i]}
              </Chip>
            ))}
          </div>
        </fieldset>
      )}

      <label className="mb-2 block text-sm font-medium" htmlFor={amountId}>
        Amount {eachPeriod(current)}
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
          {terms.map((t) => (
            <Chip key={String(t)} checked={currentTerm === t} onClick={() => setChosen({ interval: current, term: t })}>
              {termLabel(t, current)}
            </Chip>
          ))}
        </div>
      </fieldset>

      {minor !== null && (
        <p className="mb-3 text-callout leading-relaxed" aria-live="polite">
          {planSummary(minor, currency, currentTerm, current)}
        </p>
      )}

      <p className="mb-2 text-sm text-mono-500">{CONSENT_LINE}</p>

      <Button
        size="lg"
        className="mt-2 w-full"
        disabled={disabled}
        aria-describedby={showReason ? reasonId : undefined}
        onClick={() => minor !== null && onStart(minor, currentTerm, current)}
      >
        <CalendarClock className="mr-2 h-5 w-5" aria-hidden /> {monthlyOnly ? 'Start monthly payments' : `Start ${ADVERB[current].toLowerCase()} payments`}
      </Button>
      {showReason && (
        <p id={reasonId} className="mt-2 text-center text-xs text-mono-600 dark:text-mono-400">
          {reason}
        </p>
      )}
    </div>
  )
}

/** One choice chip in a radiogroup: the term chips' look, shared with How often. */
function Chip({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={`pressable rounded-full border px-4 py-2 text-sm transition-colors duration-100 ${
        checked
          ? 'border-mono-900 bg-mono-900 text-white dark:border-mono-50 dark:bg-mono-50 dark:text-mono-900'
          : 'border-mono-200 dark:border-mono-800'
      }`}
    >
      {children}
    </button>
  )
}

/** Same rule as the one-off amount: reject rather than round. */
export function toMinorUnits(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const minor = Math.round(Number(trimmed) * 100)
  return Number.isFinite(minor) && minor > 0 ? minor : null
}
