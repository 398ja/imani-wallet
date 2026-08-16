/**
 * Merchant definition (spec 044) — shared so the package and the page agree on
 * what counts as a "configured merchant". Mirrors the prior `js/search.js`
 * logic: a merchant profile is "configured" when it is `active` AND declares at
 * least one issuance currency the app can price.
 */

/** Currency codes the app can price (lowercased). */
export const KNOWN_PRICED_CURRENCIES: ReadonlySet<string> = new Set([
  'usd', 'eur', 'gbp', 'jpy', 'cad', 'aud', 'chf', 'cny', 'hkd', 'sgd', 'inr',
  'krw', 'mxn', 'brl', 'zar', 'rub', 'try', 'pln', 'sek', 'nok', 'dkk', 'czk',
  'huf', 'nzd', 'thb', 'php', 'idr', 'myr', 'aed', 'sar', 'ils', 'twd', 'ars',
  'clp', 'bdt', 'pkr', 'ngn', 'vnd', 'uah', 'sat', 'sats', 'btc', 'xaf', 'xof',
]);

/** Loose shape of a merchant profile from any source (snake_case or camelCase). */
export interface MerchantProfileLike {
  active?: unknown;
  currencies?: unknown;
  issuanceCurrency?: unknown;
  issuance_currency?: unknown;
}

/**
 * True only when the profile is an active, configured merchant with a
 * known-priced issuance currency.
 */
export function isConfiguredMerchant(merchantProfile: MerchantProfileLike | null | undefined): boolean {
  if (!merchantProfile || merchantProfile.active !== true) return false;

  const candidates: string[] = [];
  if (Array.isArray(merchantProfile.currencies)) {
    for (const c of merchantProfile.currencies) {
      if (typeof c === 'string' && c.trim()) candidates.push(c.toLowerCase().trim());
    }
  }
  if (merchantProfile.issuanceCurrency) {
    candidates.push(String(merchantProfile.issuanceCurrency).toLowerCase().trim());
  }
  if (merchantProfile.issuance_currency) {
    candidates.push(String(merchantProfile.issuance_currency).toLowerCase().trim());
  }
  if (candidates.length === 0) return false;
  return candidates.some((c) => KNOWN_PRICED_CURRENCIES.has(c));
}
