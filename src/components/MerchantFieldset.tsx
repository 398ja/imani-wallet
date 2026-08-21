import { useState } from 'react'

import { CurrencySelect } from './CurrencySelect'
import { LocationField } from './LocationField'
import { ValidityPicker } from './ValidityPicker'
import { currencyLabel } from '../lib/currencies'
import { CATEGORIES, DEFAULT_VALIDITY_DAYS, type MerchantFields } from '../lib/merchant'

/**
 * The merchant metadata fields.
 *
 * What a stall IS — its name and the line describing it — is not here. That is
 * the account's own profile, asked for one step earlier at signup and edited at
 * /profile after, and `merchantBranding` already reads a stall's description
 * out of its kind-0 `about`. Asking twice produced two answers that drifted.
 *
 * One component rather than two because setting a stall up and editing it later
 * ask about the same record — possa-merchant splits them across `BusinessStep`
 * and `IssuanceStep` at signup and then restates both inside its 975-line
 * settings page, which is how the two drifted apart there.
 *
 * But they are not the same *set* of fields, and `mode` is what differs:
 *
 * - **create** asks what a stall cannot open without, plus the one answer that
 *   is only ever given once: its **currency**. Where you trade is the one thing
 *   left to settings — a merchant registering at the market does not need a map
 *   pin to make the first sale.
 * - **edit** adds where you trade, and shows **currency as read-only**.
 *
 * Currency and validity used to be a pair, "the two answers given once". They
 * are not, and the reasons never did apply equally. A single currency is what
 * makes one balance meaningful on both sides of the counter, and re-denominating
 * a stall would misdescribe every coupon it has issued. An expiry is per-coupon
 * by nature: each issued coupon carries its own, granted at issuance and unmoved
 * by anything decided later, so a stall changing the term it offers from now on
 * says nothing false about the ones already out there. The validity here is the
 * **default** — Sell can take a different term for the sale in hand.
 *
 * Controlled by the caller so each host owns its own save semantics: signup
 * publishes once at the end of `register`, settings publishes on submit.
 */
export function MerchantFieldset({
  value,
  onChange,
  disabled,
  mode,
}: {
  value: MerchantFields
  onChange: (next: MerchantFields) => void
  disabled?: boolean
  /** 'create' when the stall does not exist yet; 'edit' once it does. */
  mode: 'create' | 'edit'
}) {
  // Frozen at mount: the term the stall had when this form opened. Reading it
  // off `value` each render would move the leading chip to 30 the moment
  // `Custom` nulls the value, rearranging the row under the finger that tapped.
  const [defaultDays] = useState(() => value.voucherValidityDays ?? DEFAULT_VALIDITY_DAYS)

  const set = <K extends keyof MerchantFields>(field: K, fieldValue: MerchantFields[K]) =>
    onChange({ ...value, [field]: fieldValue })

  const toggleCategory = (category: string) =>
    set(
      'categories',
      value.categories.includes(category)
        ? value.categories.filter((c) => c !== category)
        : [...value.categories, category],
    )

  return (
    <div className="flex flex-col gap-7">
      <div>
        <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">
          What do you sell?
        </span>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((category) => {
            const active = value.categories.includes(category)
            return (
              <button
                key={category}
                type="button"
                onClick={() => toggleCategory(category)}
                disabled={disabled}
                aria-pressed={active}
                className={`pressable rounded-full border px-3 py-1.5 text-sm capitalize disabled:opacity-50 ${
                  active
                    ? 'border-mono-900 bg-mono-900 text-mono-50 dark:border-mono-50 dark:bg-mono-50 dark:text-mono-900'
                    : 'border-mono-200 text-mono-600 hover:bg-mono-100 dark:border-mono-800 dark:text-mono-300 dark:hover:bg-mono-900'
                }`}
              >
                {category}
              </button>
            )
          })}
        </div>
        <p className="mt-1.5 text-xs text-mono-500">Pick at least one.</p>
      </div>

      {/* Settings only — see the note on `mode`. */}
      {mode === 'edit' && (
        <LocationField
          value={value.location}
          onChange={(location) => set('location', location)}
          disabled={disabled}
        />
      )}

      {/* Locked after creation, unlike the validity below — see `mode`. */}
      <div>
        {mode === 'create' ? (
          <>
            <CurrencySelect
              label="Voucher currency"
              value={value.issuanceCurrency}
              onChange={(code) => set('issuanceCurrency', code)}
              disabled={disabled}
            />
            {/* Said before it is chosen, not after it is locked. */}
            <p className="mt-1.5 text-xs text-mono-500">
              Every voucher you issue uses this currency. Choose carefully — this cannot be changed
              later.
            </p>
          </>
        ) : (
          <>
            <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">
              Voucher currency
            </span>
            <p className="rounded-2xl border border-mono-200 px-3.5 py-2.5 text-sm text-mono-900 dark:border-mono-800 dark:text-mono-50">
              {currencyLabel(value.issuanceCurrency)}
            </p>
            <p className="mt-1.5 text-xs text-mono-500">
              Fixed when you started selling. Every voucher you have issued is in this currency.
            </p>
          </>
        )}
      </div>

      {/* The default leads its own row, so it is whatever this stall last saved
          rather than the app's 30 — except at signup, where there is no stall
          yet and 30 is the only sensible thing to lead with. */}
      <ValidityPicker
        label="Vouchers stay valid for"
        value={value.voucherValidityDays}
        defaultDays={defaultDays}
        onChange={(days) => set('voucherValidityDays', days)}
        disabled={disabled}
        hint={
          mode === 'create'
            ? 'You can change this later, and pick a different length on any single sale.'
            : 'Applies to vouchers you issue from now on. Vouchers already issued keep their own expiry date, and you can pick a different length on any single sale.'
        }
      />
    </div>
  )
}
