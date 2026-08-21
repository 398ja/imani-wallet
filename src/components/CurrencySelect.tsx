import { useId, useRef, useState, type KeyboardEvent } from 'react'

import { currencyLabel, searchCurrencies, type Currency } from '../lib/currencies'

/**
 * Pick a currency by typing its name.
 *
 * A dropdown of every ISO currency is three hundred rows of scrolling, and a
 * dropdown of twelve is a wall for everyone whose money is not on the list. So
 * the merchant types — "shil", "euro", "eur" — and picks from what matches.
 * What is STORED is the three-letter code, unchanged; what is SHOWN is the name
 * and the code together, because a code alone is not something most people can
 * check they got right.
 *
 * Hand-rolled rather than `<input list>` + `<datalist>`, which is the obvious
 * platform answer and does not work here: browsers disagree about whether an
 * option's `label` is matched against what was typed at all — Firefox filters
 * on the value only — so typing a NAME would silently match nothing on some of
 * them. Everything else the native control gives is reproduced below:
 * `role="combobox"`, arrow keys, Enter, Escape, and `aria-activedescendant`.
 */
export function CurrencySelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  /** ISO 4217 code, e.g. `EUR`. */
  value: string
  onChange: (code: string) => void
  disabled?: boolean
}) {
  const inputId = useId()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)

  // null means "not being edited": the field shows the chosen currency rather
  // than anything typed. Focus starts an edit at empty, so the common list is
  // the first thing offered and typing replaces rather than appends.
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  const chosen = value === '' ? '' : currencyLabel(value)
  const open = query !== null
  const matches = open ? searchCurrencies(query) : []

  const choose = (currency: Currency) => {
    onChange(currency.code)
    setQuery(null)
    input.current?.blur()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => Math.min(Math.max(i + step, 0), matches.length - 1))
      return
    }
    if (e.key === 'Enter' && matches[active]) {
      // Only when there is something to take. Otherwise Enter belongs to the
      // form, and swallowing it here would strand a merchant on the step.
      e.preventDefault()
      choose(matches[active])
      return
    }
    if (e.key === 'Escape') {
      setQuery(null)
      input.current?.blur()
    }
  }

  return (
    <div>
      <label
        htmlFor={inputId}
        className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300"
      >
        {label}
      </label>

      <div className="relative">
        {/* Says "typeable" before anything is tapped — at rest the field shows a
            chosen currency and otherwise reads as a value, not a search box.
            Behind the input in the DOM and click-through, so tapping it focuses
            the field like tapping anywhere else in the box does. */}
        <svg
          viewBox="0 0 24 24"
          className={`pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mono-400 ${
            disabled ? 'opacity-50' : ''
          }`}
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M16.5 16.5 21 21" />
        </svg>
        <input
          ref={input}
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          // Off, or the browser's own saved-values dropdown covers this one.
          autoComplete="off"
          value={query ?? chosen}
          // The chosen currency is never lost while typing: it is the
          // placeholder for as long as the field is empty.
          placeholder={chosen || 'Type a currency name'}
          disabled={disabled}
          onFocus={() => {
            setQuery('')
            setActive(0)
          }}
          // Closes on an outside click too — the options below cancel their own
          // mousedown, so choosing one never blurs first.
          onBlur={() => setQuery(null)}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded-2xl border border-mono-200 bg-white py-2.5 pl-10 pr-3.5 text-sm text-mono-900 placeholder:text-mono-400 focus:border-mono-900 focus:outline-none disabled:opacity-50 dark:border-mono-800 dark:bg-mono-950 dark:text-mono-50 dark:focus:border-mono-50"
        />

        {open && matches.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            className="materialize absolute inset-x-0 top-full z-10 mt-1 origin-top overflow-hidden rounded-2xl border border-mono-200 bg-white shadow-lg dark:border-mono-800 dark:bg-mono-900"
          >
            {/* The list opens on a short list of common currencies, which reads
                as the whole choice unless something says otherwise. It sits
                inside the list rather than under the field because that is
                where the eye already is once the list is open. */}
            {query === '' && (
              <li
                role="presentation"
                className="border-b border-mono-100 px-3.5 py-2 text-xs text-mono-500 dark:border-mono-800"
              >
                Common currencies — type a name to search every other one
              </li>
            )}
            {matches.map((currency, i) => (
              <li
                key={currency.code}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: click lands after blur, and blur has
                // already closed the list by then.
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(currency)
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-sm ${
                  i === active
                    ? 'bg-mono-100 dark:bg-mono-800'
                    : 'text-mono-900 dark:text-mono-50'
                }`}
              >
                <span className="min-w-0 truncate">{currency.name}</span>
                <span className="shrink-0 text-xs text-mono-500">{currency.code}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && query !== '' && matches.length === 0 && (
        <p className="mt-1.5 text-xs text-mono-500">No currency matches “{query}”.</p>
      )}
    </div>
  )
}
