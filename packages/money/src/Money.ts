/**
 * Money — integer-based monetary arithmetic.
 *
 * All amounts are stored as integers in minor units (cents, satoshis, whole units for
 * zero-decimal currencies). This avoids floating-point rounding errors entirely.
 *
 * @example
 * ```ts
 * const price = Money.fromMajor(12.50, 'EUR');   // 1250 (cents)
 * const half = price.split(0.5);                  // { keep: 625, give: 625 }
 * price.format();                                 // "€12,50"
 * price.toMajor();                                // 12.5
 * ```
 */

import { getCurrency, getDecimals, type CurrencyConfig } from './currencies.js';
import {
  parseLocaleAmount,
  type ParseLocaleAmountOptions,
  type ParseFailureReason,
} from './parseLocaleAmount.js';

/**
 * Named errors thrown by Money.fromLocaleString — one class per parseLocaleAmount failure reason.
 * The convention follows the contract's 1:1 reason→error-class mapping (spec 046).
 */
export class EmptyAmountError extends Error {
  constructor() {
    super('Amount is empty');
    this.name = 'EmptyAmountError';
  }
}
export class IncompleteAmountError extends Error {
  constructor() {
    super('Amount is incomplete (trailing decimal separator with no fractional digits)');
    this.name = 'IncompleteAmountError';
  }
}
export class InvalidAmountError extends Error {
  constructor(detail?: string) {
    super(detail ? `Invalid amount: ${detail}` : 'Invalid amount');
    this.name = 'InvalidAmountError';
  }
}
export class TooManyDecimalsError extends Error {
  constructor() {
    super('Amount has more fractional digits than the currency allows');
    this.name = 'TooManyDecimalsError';
  }
}
export class OverflowError extends Error {
  constructor() {
    super('Amount exceeds Number.MAX_SAFE_INTEGER');
    this.name = 'OverflowError';
  }
}

function errorForReason(reason: ParseFailureReason): Error {
  switch (reason) {
    case 'empty':
      return new EmptyAmountError();
    case 'incomplete':
      return new IncompleteAmountError();
    case 'invalid':
      return new InvalidAmountError();
    case 'too_many_decimals':
      return new TooManyDecimalsError();
    case 'overflow':
      return new OverflowError();
  }
}

export class Money {
  /** Amount in minor units (integer) */
  readonly amount: number;
  /** Currency code */
  readonly currency: string;
  /** Number of decimal places for this currency */
  readonly decimals: number;

  private constructor(amount: number, currency: string) {
    if (!Number.isFinite(amount)) {
      throw new Error(`Money amount must be finite, got ${amount}`);
    }
    this.amount = Math.round(amount); // enforce integer
    this.currency = currency.toUpperCase();
    this.decimals = getDecimals(this.currency);
  }

  // ==========================================
  // Factory Methods
  // ==========================================

  /**
   * Create Money from minor units (cents, satoshis, etc.).
   * This is the canonical constructor — the amount is already an integer.
   */
  static fromMinor(minorAmount: number, currency: string): Money {
    return new Money(minorAmount, currency);
  }

  /**
   * Create Money from major units (e.g., 12.50 EUR → 1250 minor).
   * For zero-decimal currencies, major and minor are the same.
   */
  static fromMajor(majorAmount: number, currency: string): Money {
    const decimals = getDecimals(currency);
    const factor = Math.pow(10, decimals);
    return new Money(Math.round(majorAmount * factor), currency);
  }

  /**
   * Create zero Money for a currency.
   */
  static zero(currency: string): Money {
    return new Money(0, currency);
  }

  /**
   * Create Money from a locale-formatted string (e.g. "5,50" on fr-FR, "5.50" on en-US).
   *
   * Throws one of the named errors (`EmptyAmountError`, `IncompleteAmountError`,
   * `InvalidAmountError`, `TooManyDecimalsError`, `OverflowError`) on parse failure —
   * 1:1 with `parseLocaleAmount`'s reason union per the spec-046 contract.
   *
   * Callers that prefer a discriminated union (no exceptions) should call
   * `parseLocaleAmount` directly.
   */
  static fromLocaleString(
    input: string,
    currency: string,
    options?: ParseLocaleAmountOptions,
  ): Money {
    const result = parseLocaleAmount(input, currency, options);
    if (!result.ok) throw errorForReason(result.reason);
    return new Money(result.minorUnits, result.currency);
  }

  // ==========================================
  // Conversion
  // ==========================================

  /**
   * Convert minor units to major units (e.g., 1250 → 12.50 for EUR).
   * For zero-decimal currencies, returns the amount as-is.
   */
  toMajor(): number {
    if (this.decimals === 0) return this.amount;
    return this.amount / Math.pow(10, this.decimals);
  }

  /**
   * Get the amount in minor units (identity, but named for clarity).
   */
  toMinor(): number {
    return this.amount;
  }

  // ==========================================
  // Arithmetic (returns new Money, immutable)
  // ==========================================

  /**
   * Add another amount (in minor units) of the same currency.
   */
  add(minorAmount: number): Money {
    return new Money(this.amount + Math.round(minorAmount), this.currency);
  }

  /**
   * Subtract another amount (in minor units) of the same currency.
   */
  subtract(minorAmount: number): Money {
    return new Money(this.amount - Math.round(minorAmount), this.currency);
  }

  /**
   * Multiply by a factor (result is rounded to integer minor units).
   */
  multiply(factor: number): Money {
    return new Money(Math.round(this.amount * factor), this.currency);
  }

  /**
   * Split this amount by ratio. Guarantees keep + give === total (no rounding loss).
   *
   * @param keepRatio - Fraction to keep (0..1). The remainder goes to `give`.
   * @returns Object with `keep` and `give` Money instances.
   */
  split(keepRatio: number): { keep: Money; give: Money } {
    if (keepRatio < 0 || keepRatio > 1) {
      throw new Error(`keepRatio must be between 0 and 1, got ${keepRatio}`);
    }
    const keepAmount = Math.round(this.amount * keepRatio);
    const giveAmount = this.amount - keepAmount; // remainder — no rounding loss
    return {
      keep: new Money(keepAmount, this.currency),
      give: new Money(giveAmount, this.currency),
    };
  }

  /**
   * Check if the amount is zero.
   */
  isZero(): boolean {
    return this.amount === 0;
  }

  /**
   * Check if the amount is positive (> 0).
   */
  isPositive(): boolean {
    return this.amount > 0;
  }

  // ==========================================
  // Formatting
  // ==========================================

  /**
   * Format as a human-readable string using the currency's display conventions.
   *
   * When `options.locale` is supplied, the digit-grouping + decimal-separator phase
   * delegates to `Intl.NumberFormat(options.locale, ...)` so the output uses the
   * device locale (spec-046 FR-004). The currency symbol is always taken from the
   * currency registry. When the option is omitted, behaviour is unchanged for back-compat.
   *
   * @example
   * Money.fromMinor(1250, 'EUR').format()                       // "€12,50" (currency-bundled)
   * Money.fromMinor(1250, 'EUR').format({locale: 'en-US'})      // "€12.50" (device locale)
   * Money.fromMinor(5000, 'XAF').format()                       // "5 000 FCFA"
   * Money.fromMinor(100000, 'SAT').format()                     // "100,000 sats"
   */
  format(options?: { locale?: string }): string {
    const config = getCurrency(this.currency);
    const major = this.toMajor();

    let formatted: string;
    if (options?.locale) {
      formatted = new Intl.NumberFormat(options.locale, {
        minimumFractionDigits: config.decimals,
        maximumFractionDigits: config.decimals,
      }).format(major);
    } else {
      formatted = formatNumber(major, config);
    }

    if (config.symbolPosition === 'before') {
      return `${config.symbol}${formatted}`;
    }
    return `${formatted} ${config.symbol}`;
  }

  /**
   * Format as a plain number string (no symbol), useful for input fields.
   *
   * When `options.locale` is supplied, uses `Intl.NumberFormat(options.locale, ...)`;
   * otherwise uses the currency's bundled separators.
   */
  formatPlain(options?: { locale?: string }): string {
    const config = getCurrency(this.currency);
    const major = this.toMajor();
    if (options?.locale) {
      return new Intl.NumberFormat(options.locale, {
        minimumFractionDigits: config.decimals,
        maximumFractionDigits: config.decimals,
      }).format(major);
    }
    return formatNumber(major, config);
  }

  toString(): string {
    return `Money(${this.amount} ${this.currency})`;
  }
}

// ==========================================
// Standalone utility functions
// ==========================================

/**
 * Convert a major-unit amount to minor units for a given currency.
 * Standalone function for use without creating a Money instance.
 *
 * @example
 * toMinorUnits(12.50, 'EUR')  // 1250
 * toMinorUnits(5000, 'XAF')   // 5000
 */
export function toMinorUnits(majorAmount: number, currency: string): number {
  const decimals = getDecimals(currency);
  return Math.round(majorAmount * Math.pow(10, decimals));
}

/**
 * Convert minor units to major units for a given currency.
 * Standalone function for use without creating a Money instance.
 *
 * @example
 * toMajorUnits(1250, 'EUR')  // 12.5
 * toMajorUnits(5000, 'XAF')  // 5000
 */
export function toMajorUnits(minorAmount: number, currency: string): number {
  const decimals = getDecimals(currency);
  if (decimals === 0) return minorAmount;
  return minorAmount / Math.pow(10, decimals);
}

/**
 * Format a minor-unit amount as a display string.
 * Standalone function for use without creating a Money instance.
 *
 * When `options.locale` is supplied, uses `Intl.NumberFormat(options.locale, ...)` for
 * digit grouping and decimal separator (spec-046 FR-004); the currency symbol still
 * comes from the registry. When omitted, behaviour is unchanged.
 *
 * @example
 * formatMoney(1250, 'EUR')                       // "€12,50" (currency-bundled)
 * formatMoney(1250, 'EUR', {locale: 'en-US'})    // "€12.50"
 * formatMoney(5000, 'XAF')                       // "5 000 FCFA"
 */
export function formatMoney(
  minorAmount: number,
  currency: string,
  options?: { locale?: string },
): string {
  return Money.fromMinor(minorAmount, currency).format(options);
}

/**
 * Split a minor-unit amount by ratio, ensuring keep + give === total.
 *
 * @returns Tuple [keepMinor, giveMinor]
 */
export function splitAmount(totalMinor: number, keepRatio: number): [number, number] {
  const keep = Math.round(totalMinor * keepRatio);
  return [keep, totalMinor - keep];
}

// ==========================================
// Internal helpers
// ==========================================

function formatNumber(value: number, config: CurrencyConfig): string {
  const { decimals, thousandsSeparator, decimalSeparator } = config;

  // Use fixed-point to get the right number of decimal places
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');

  // Add thousands separators
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSeparator);

  const sign = value < 0 ? '-' : '';

  if (decimals === 0 || !decPart) {
    return `${sign}${withThousands}`;
  }
  return `${sign}${withThousands}${decimalSeparator}${decPart}`;
}
