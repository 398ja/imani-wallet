import { CurrencySelect } from './CurrencySelect'
import { LocationField } from './LocationField'
import { currencyLabel } from '../lib/currencies'
import { CATEGORIES, VALIDITY_DAYS, type MerchantFields } from '../lib/merchant'

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
 * - **create** asks what a stall cannot open without, plus the two answers that
 *   are only ever given once: **currency and coupon validity**. Where you trade
 *   is the one thing left to settings — a merchant registering at the market
 *   does not need a map pin to make the first sale.
 * - **edit** adds where you trade, and shows **currency and validity as
 *   read-only**. Both are chosen at creation and fixed after, because coupons
 *   already issued carry the unit and the expiry they were issued with:
 *   changing either later would describe the stall's history inaccurately
 *   without altering a single live coupon. A single currency is also what makes
 *   one balance meaningful, on both sides of the counter.
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

      {/* Same shape as validity below, and for the same reason — see `mode`. */}
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

      <div>
        <span className="mb-2 block text-sm font-medium text-mono-700 dark:text-mono-300">
          Vouchers stay valid for
        </span>

        {mode === 'create' ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {VALIDITY_DAYS.map((days) => {
                const active = value.voucherValidityDays === days
                return (
                  <button
                    key={days}
                    type="button"
                    onClick={() => set('voucherValidityDays', days)}
                    disabled={disabled}
                    aria-pressed={active}
                    className={`pressable rounded-2xl border py-2.5 text-sm font-medium disabled:opacity-50 ${
                      active
                        ? 'border-mono-900 bg-mono-900 text-mono-50 dark:border-mono-50 dark:bg-mono-50 dark:text-mono-900'
                        : 'border-mono-200 text-mono-600 hover:bg-mono-100 dark:border-mono-800 dark:text-mono-300 dark:hover:bg-mono-900'
                    }`}
                  >
                    {days} days
                  </button>
                )
              })}
            </div>
            {/* Said before it is chosen, not after it is locked. */}
            <p className="mt-1.5 text-xs text-mono-500">
              Choose carefully — this cannot be changed later.
            </p>
          </>
        ) : (
          // Rendered as a plain value rather than a disabled control: a greyed-out
          // set of buttons reads as "temporarily unavailable" and invites a hunt
          // for whatever would re-enable them. Nothing will.
          <>
            <p className="rounded-2xl border border-mono-200 px-3.5 py-2.5 text-sm text-mono-900 dark:border-mono-800 dark:text-mono-50">
              {value.voucherValidityDays} days
            </p>
            <p className="mt-1.5 text-xs text-mono-500">
              Fixed when you started selling. Vouchers already issued keep their own expiry date.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
