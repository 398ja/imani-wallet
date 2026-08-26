import { useState } from 'react'

import { Input } from './ui'
import { MAX_VALIDITY_DAYS, MIN_VALIDITY_DAYS, validValidityDays, validityChoices } from '../lib/merchant'

/**
 * How long a coupon stays valid: the stall's own term, a preset, or a typed one.
 *
 * The same control in both places it is asked for — the stall's default in
 * settings and signup, and the term for the sale in hand on Sell — because they
 * are the same question with different scopes, and two pickers would drift the
 * way possa-merchant's `IssuanceStep` and its settings page drifted.
 *
 * `value` is null only while a custom term is half-typed. Every caller gates its
 * submit on that, which is the whole reason the null exists rather than the
 * picker quietly holding the last good number: an unfinished 4 must not send a
 * 4-day coupon, and it must not silently send 30 either.
 */
export function ValidityPicker({
  value,
  defaultDays,
  onChange,
  disabled,
  label = 'Vouchers stay valid for',
  hint,
}: {
  /** Null while a custom term is being typed and is not a validity yet. */
  value: number | null
  /** The stall's default. Leads the row — see `validityChoices`. */
  defaultDays: number
  onChange: (days: number | null) => void
  disabled?: boolean
  label?: string
  hint?: string
}) {
  // Null when the field is closed; the raw text while it is open. Raw rather
  // than a number because "" and "4" are both states the field must be able to
  // sit in, and neither is a term.
  const [custom, setCustom] = useState<string | null>(null)

  const choices = validityChoices(defaultDays)

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">
        {label}
      </span>

      {/* Wrapping pills rather than a fixed grid: the row is four or five wide
          depending on whether this stall's term is already a preset. Same shape
          as the category picker. */}
      <div className="flex flex-wrap gap-2">
        {choices.map((days) => {
          const active = custom === null && value === days
          return (
            <button
              key={days}
              type="button"
              onClick={() => {
                // Discards whatever was typed, deliberately: one selected chip
                // is the whole truth of what is about to be issued, and a stale
                // custom value sitting open beside it reads two ways.
                setCustom(null)
                onChange(days)
              }}
              disabled={disabled}
              aria-pressed={active}
              className={chip(active)}
            >
              {days} days
              {days === defaultDays && choices.length > 1 && (
                <span className="ml-1 opacity-60">· default</span>
              )}
            </button>
          )
        })}

        <button
          type="button"
          onClick={() => {
            // Empty, not seeded with the current value: nothing is chosen until
            // they type, and `onChange(null)` says so to the submit button.
            setCustom('')
            onChange(null)
          }}
          disabled={disabled}
          aria-pressed={custom !== null}
          className={chip(custom !== null)}
        >
          Custom
        </button>
      </div>

      {custom !== null && (
        <div className="mt-3">
          <Input
            type="number"
            inputMode="numeric"
            min={MIN_VALIDITY_DAYS}
            max={MAX_VALIDITY_DAYS}
            step={1}
            placeholder={`Days (${MIN_VALIDITY_DAYS}–${MAX_VALIDITY_DAYS})`}
            value={custom}
            disabled={disabled}
            autoFocus
            onChange={(e) => {
              setCustom(e.target.value)
              onChange(validValidityDays(e.target.value))
            }}
            // Silent while the field is still empty — a blank field is not yet
            // a mistake, it is a field nobody has typed in.
            error={
              custom !== '' && validValidityDays(custom) === null
                ? `Enter a whole number of days between ${MIN_VALIDITY_DAYS} and ${MAX_VALIDITY_DAYS}.`
                : undefined
            }
          />
        </div>
      )}

      {hint && <p className="mt-1.5 text-xs text-mono-500">{hint}</p>}
    </div>
  )
}

const chip = (active: boolean) =>
  `pressable rounded-full border px-3 py-1.5 text-sm disabled:opacity-50 ${
    active
      ? 'border-mono-900 bg-mono-900 text-mono-50 dark:border-mono-50 dark:bg-mono-50 dark:text-mono-900'
      : 'border-mono-200 text-mono-600 hover:bg-mono-100 dark:border-mono-800 dark:text-mono-300 dark:hover:bg-mono-900'
  }`
