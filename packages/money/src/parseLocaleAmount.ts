/**
 * Locale-aware amount parsing.
 *
 * Translates a user-typed string in a device locale (e.g. "5,50" on fr-FR or "5.50" on en-US)
 * into a canonical integer minor-units amount (e.g. 550 for 5.50 EUR).
 *
 * Spec: 046-locale-decimal-separator.
 */

import { getDecimals } from './currencies.js';

/**
 * Options for parseLocaleAmount / Money.fromLocaleString.
 *
 * Host-side callers (the `shared/localeAmountInputIntegration.js` bridge and `shared/format.js`
 * display helpers) MUST pass the deterministic device-locale expression
 * `navigator.languages?.[0] ?? navigator.language ?? 'en-US'` — encapsulated in the
 * `getDeviceLocale()` accessor exported from `shared/format.js` so input and display paths
 * cannot drift.
 */
export interface ParseLocaleAmountOptions {
  /** Locale tag (e.g. "fr-FR"). Defaults to "en-US". */
  locale?: string;
  /** When true, accept "." as decimal separator even when the locale uses ",". Defaults to true. */
  acceptPeriodFallback?: boolean;
}

export type ParsedLocaleAmount =
  | { ok: true; minorUnits: number; major: number; currency: string }
  | { ok: false; reason: ParseFailureReason };

export type ParseFailureReason =
  | 'empty'
  | 'incomplete'
  | 'invalid'
  | 'too_many_decimals'
  | 'overflow';

// Locale-resolution cache. Resolving a locale's separators via Intl.NumberFormat is
// not free; in a per-keystroke parse path we want the result memoised.
const LOCALE_CACHE = new Map<string, { decimal: string; group: string }>();

/**
 * Resolve a locale's decimal and group separator characters using Intl.NumberFormat.
 * Returns the canonical separators reported by the platform — never hand-rolled.
 */
function resolveSeparators(locale: string): { decimal: string; group: string } {
  const cached = LOCALE_CACHE.get(locale);
  if (cached) return cached;

  let decimal = '.';
  let group = ',';
  try {
    const fmt = new Intl.NumberFormat(locale);
    const parts = fmt.formatToParts(12345.6);
    for (const part of parts) {
      if (part.type === 'decimal') decimal = part.value;
      else if (part.type === 'group') group = part.value;
    }
  } catch {
    // Unknown locale — fall back to en-US defaults already initialised above.
  }
  const result = { decimal, group };
  LOCALE_CACHE.set(locale, result);
  return result;
}

/**
 * Group separators on fr-FR / de-DE etc. are reported by the platform as U+00A0 NBSP or
 * U+202F NNBSP. Mobile keyboards and pasted strings frequently substitute the regular
 * U+0020 SPACE. We treat all three as equivalent on the read side so a customer typing
 * a regular space character can still get a successful group-strict parse.
 */
const SPACE_GROUP_CHARS = new Set([' ', ' ', ' ']);

/**
 * Parse a locale-strict string into [integerPart, fractionPart] digit strings.
 * Returns null on grammar miss.
 *
 * Grammar: digits{1,3} ( group-sep digits{3} )* ( decimal-sep digits{1,M} )?
 *        | decimal-sep digits{1,M}
 *
 * Where M is unbounded here (caller flags `too_many_decimals` if fracPart.length > N).
 *
 * Grouping is enforced strictly: when the group separator appears in the integer part,
 * the leading chunk must be 1-3 digits and every subsequent chunk must be exactly 3 digits.
 * This is what rejects "5,50" on en-US (1+2 not a valid en-US group), per SC-004.
 */
function localeStrictParse(
  input: string,
  decimal: string,
  group: string,
): { intPart: string; fracPart: string } | null {
  // Locate the decimal separator; reject inputs with more than one occurrence.
  const decimalIdx = input.indexOf(decimal);
  if (decimalIdx !== -1 && input.indexOf(decimal, decimalIdx + decimal.length) !== -1) {
    return null;
  }
  const intStr = decimalIdx === -1 ? input : input.slice(0, decimalIdx);
  const fracStr = decimalIdx === -1 ? '' : input.slice(decimalIdx + decimal.length);

  // Validate the integer side — including the 3-digit grouping rule when a group sep appears.
  let intPart: string;
  if (intStr === '') {
    // Leading-decimal form (".50" / ",50") → treat the integer side as "0".
    intPart = '0';
  } else {
    intPart = validateAndFlattenIntegerPart(intStr, group);
    if (intPart === null as unknown as string) return null;
  }

  // The fractional side must be digits-only (zero or more); length cap is enforced by the caller.
  if (fracStr !== '' && !/^\d+$/.test(fracStr)) return null;

  return { intPart, fracPart: fracStr };
}

/**
 * Validate the integer side of a locale-formatted number and return the digits-only form.
 * Enforces 3-digit grouping: lead chunk in [1,3] digits; subsequent chunks exactly 3 digits.
 * Returns null on grammar miss.
 *
 * Handles space-like group separators (U+0020 / U+00A0 / U+202F) interchangeably — mobile
 * keyboards substitute the ASCII space for the platform's reported NBSP / NNBSP.
 */
function validateAndFlattenIntegerPart(intStr: string, group: string): string {
  const groupIsSpaceLike = SPACE_GROUP_CHARS.has(group);
  // Tokenise on the group separator.
  let chunks: string[];
  if (groupIsSpaceLike) {
    chunks = intStr.split(/[   ]/);
  } else {
    chunks = intStr.split(group);
  }

  if (chunks.length === 1) {
    // No grouping present — accept any-length all-digit string.
    return /^\d+$/.test(chunks[0]) ? chunks[0] : (null as unknown as string);
  }

  // Grouped: first chunk 1-3 digits, every other chunk exactly 3 digits.
  const head = chunks[0];
  if (!/^\d{1,3}$/.test(head)) return null as unknown as string;
  for (let i = 1; i < chunks.length; i++) {
    if (!/^\d{3}$/.test(chunks[i])) return null as unknown as string;
  }
  return chunks.join('');
}

/**
 * Compose integer + fractional digit strings into a minor-units integer, right-zero-padding
 * the fractional portion to the currency's decimal places (FR-006).
 *
 * Returns null on overflow past Number.MAX_SAFE_INTEGER.
 */
function composeMinorUnits(intPart: string, fracPart: string, decimals: number): number | null {
  // Right-zero-pad the fractional portion.
  const padded = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  // For zero-decimal currencies, the fractional portion is dropped entirely.
  const combined = decimals === 0 ? intPart : intPart + padded;
  // Strip leading zeros so Number() doesn't see octal-looking strings.
  const stripped = combined.replace(/^0+(?=\d)/, '');
  const n = Number(stripped === '' ? '0' : stripped);
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

/**
 * Parse a locale-formatted amount string into a canonical minor-units integer.
 *
 * See `specs/046-locale-decimal-separator/contracts/parse-locale-amount.md` for the
 * full behaviour spec and example table.
 */
export function parseLocaleAmount(
  input: string,
  currency: string,
  options: ParseLocaleAmountOptions = {},
): ParsedLocaleAmount {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };

  // FR-011 — unsigned customer entry. Reject leading + / - before anything else.
  const firstChar = trimmed.charAt(0);
  if (firstChar === '+' || firstChar === '-') return { ok: false, reason: 'invalid' };

  // FR-003 — non-exponential. Reject scientific notation.
  if (/[eE]/.test(trimmed)) return { ok: false, reason: 'invalid' };

  const locale = options.locale ?? 'en-US';
  const acceptPeriodFallback = options.acceptPeriodFallback ?? true;
  const { decimal, group } = resolveSeparators(locale);
  const decimals = getDecimals(currency);
  const upperCurrency = currency.toUpperCase();

  // Trailing-decimal-separator detection — "5," on fr-FR, "5." on en-US. This MUST run
  // before the period-fallback branch so an en-US "5." is reported as `incomplete`, not
  // as `valid` via the fallback. Only meaningful on currencies that have decimals.
  if (decimals > 0 && trimmed.endsWith(decimal) && !trimmed.slice(0, -decimal.length).includes(decimal)) {
    const before = trimmed.slice(0, -decimal.length);
    if (/^\d+(?:[\s  ]*\d+)*$/.test(before) || before === '') {
      return { ok: false, reason: 'incomplete' };
    }
  }
  // Period-fallback trailing case ("5." on fr-FR where '.' is not the locale decimal).
  if (decimals > 0 && acceptPeriodFallback && decimal !== '.' && trimmed.endsWith('.')) {
    const before = trimmed.slice(0, -1);
    if (!before.includes(',') && !before.includes('.') && /^\d+$/.test(before)) {
      return { ok: false, reason: 'incomplete' };
    }
  }

  // Step 1: locale-strict parse.
  const strict = localeStrictParse(trimmed, decimal, group);
  if (strict) {
    // FR-005 — zero-decimal currencies MUST reject any decimal separator regardless of
    // whether the strict parse succeeded. Check BEFORE the too_many_decimals branch so the
    // failure reason is `invalid` (per SC-005), not `too_many_decimals`.
    if (decimals === 0 && (strict.fracPart.length > 0 || trimmed.includes(decimal))) {
      return { ok: false, reason: 'invalid' };
    }
    if (strict.fracPart.length > decimals) {
      return { ok: false, reason: 'too_many_decimals' };
    }
    const minor = composeMinorUnits(strict.intPart, strict.fracPart, decimals);
    if (minor === null) return { ok: false, reason: 'overflow' };
    const majorStr = decimals === 0
      ? strict.intPart
      : `${strict.intPart}.${(strict.fracPart + '0'.repeat(decimals)).slice(0, decimals)}`;
    const major = Number(majorStr);
    return { ok: true, minorUnits: minor, major, currency: upperCurrency };
  }

  // Step 2: period-fallback parse — only when the locale decimal is not already '.', the
  // string contains zero-or-one '.', and no ',' (lone-comma never fallback per SC-004).
  if (acceptPeriodFallback && decimal !== '.' && !trimmed.includes(',')) {
    const periodCount = (trimmed.match(/\./g) ?? []).length;
    if (periodCount <= 1) {
      const fallback = localeStrictParse(trimmed, '.', group);
      if (fallback) {
        if (decimals === 0 && (fallback.fracPart.length > 0 || trimmed.includes('.'))) {
          return { ok: false, reason: 'invalid' };
        }
        if (fallback.fracPart.length > decimals) {
          return { ok: false, reason: 'too_many_decimals' };
        }
        const minor = composeMinorUnits(fallback.intPart, fallback.fracPart, decimals);
        if (minor === null) return { ok: false, reason: 'overflow' };
        const majorStr = decimals === 0
          ? fallback.intPart
          : `${fallback.intPart}.${(fallback.fracPart + '0'.repeat(decimals)).slice(0, decimals)}`;
        const major = Number(majorStr);
        return { ok: true, minorUnits: minor, major, currency: upperCurrency };
      }
    }
  }

  return { ok: false, reason: 'invalid' };
}
