import { CURRENCIES } from './merchant'

/**
 * Every currency the browser knows, by name.
 *
 * No bundled ISO 4217 table, and no dependency: `Intl.supportedValuesOf` is the
 * runtime's own list of currency codes — around 300 of them — and
 * `Intl.DisplayNames` names each one in the USER'S language, so a French
 * merchant reads "euro" and a Kenyan one reads "Kenyan Shilling" without this
 * app shipping either string, or a translation of either string.
 *
 * The wire format does not change: what is stored on the merchant record is
 * still the three-letter code, which is what `currencyDecimals` and every
 * amount on both sides of the counter are already keyed by.
 *
 * Both Intl calls are guarded. `supportedValuesOf` is ES2022 and throws a
 * RangeError for a key an older runtime does not know, and a browser built
 * without full ICU can refuse `DisplayNames` outright — in either case the app
 * falls back to the twelve common codes and to bare codes as labels, which is
 * exactly what it showed before this existed.
 */

export interface Currency {
  code: string
  /** In the user's own language. Falls back to the code itself. */
  name: string
}

let namer: Intl.DisplayNames | null | undefined
let all: Currency[] | undefined
let common: Currency[] | undefined

function currencyNamer(): Intl.DisplayNames | null {
  if (namer === undefined) {
    try {
      namer = new Intl.DisplayNames(undefined, { type: 'currency' })
    } catch {
      namer = null
    }
  }
  return namer
}

/** The currency's name, or the code unchanged when there is no name for it. */
export function currencyName(code: string): string {
  try {
    // `of` returns its input for a code it does not recognise, which is already
    // the fallback we want — no branch needed for the unknown case.
    return currencyNamer()?.of(code) ?? code
  } catch {
    return code
  }
}

/** `"Euro (EUR)"` — what a merchant reads back after choosing. */
export function currencyLabel(code: string): string {
  const name = currencyName(code)
  // Not "EUR (EUR)" when the runtime has no name for it.
  return name === code ? code : `${name} (${code})`
}

/** Every code this runtime knows, named and sorted by name. */
export function allCurrencies(): Currency[] {
  if (!all) {
    let codes: readonly string[] = CURRENCIES
    try {
      if (typeof Intl.supportedValuesOf === 'function') {
        codes = Intl.supportedValuesOf('currency')
      }
    } catch {
      // Leaves the common list in place.
    }
    all = codes
      .map((code) => ({ code, name: currencyName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
  return all
}

/** What to offer before anything has been typed. */
export function commonCurrencies(): Currency[] {
  if (!common) {
    common = CURRENCIES.map((code) => ({ code, name: currencyName(code) }))
  }
  return common
}

/**
 * Fold accents and case away, so "Réunion" is reachable by typing "reunion".
 *
 * These names come from the user's own locale, not from an English table, so
 * some of them genuinely carry diacritics the keyboard in front of them may not.
 */
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/**
 * Currencies matching what has been typed, best first.
 *
 * Ranked rather than merely filtered, because the two things a merchant types
 * pull in opposite directions: someone typing "eur" wants EUR at the top and
 * not the eleven other currencies whose NAME contains "eur". So an exact code
 * wins, then a code prefix, then a name that starts with the query, then a name
 * that merely contains it.
 */
export function searchCurrencies(query: string, limit = 8): Currency[] {
  const q = fold(query.trim())
  if (q === '') return commonCurrencies().slice(0, limit)

  const ranked: Array<{ currency: Currency; rank: number }> = []
  for (const currency of allCurrencies()) {
    const code = currency.code.toLowerCase()
    const name = fold(currency.name)
    const rank =
      code === q ? 0 : code.startsWith(q) ? 1 : name.startsWith(q) ? 2 : name.includes(q) ? 3 : -1
    if (rank >= 0) ranked.push({ currency, rank })
  }

  return ranked
    .sort((a, b) => a.rank - b.rank || a.currency.name.localeCompare(b.currency.name))
    .slice(0, limit)
    .map((entry) => entry.currency)
}
