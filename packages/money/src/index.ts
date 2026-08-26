/**
 * @imani/money
 *
 * Currency registry and safe money arithmetic for Imani apps.
 * All amounts are stored as integers in minor units to avoid floating-point errors.
 *
 * @example
 * ```ts
 * import { Money, isZeroDecimal, toMinorUnits, formatMoney } from '@imani/money';
 *
 * // Class-based API
 * const price = Money.fromMajor(12.50, 'EUR');
 * price.format();      // "€12,50"
 * price.toMinor();     // 1250
 *
 * // Standalone functions
 * isZeroDecimal('XAF');           // true
 * toMinorUnits(500, 'XAF');       // 500
 * toMinorUnits(12.50, 'EUR');     // 1250
 * formatMoney(1250, 'EUR');       // "€12,50"
 * ```
 */

// Currency registry
export {
  type CurrencyConfig,
  getCurrency,
  getDecimals,
  isZeroDecimal,
  isSat,
  registerCurrency,
  getAllCurrencyCodes,
} from './currencies.js';

// Money class and standalone utilities
export {
  Money,
  toMinorUnits,
  toMajorUnits,
  formatMoney,
  splitAmount,
  // Named errors thrown by Money.fromLocaleString (1:1 with parseLocaleAmount reasons)
  EmptyAmountError,
  IncompleteAmountError,
  InvalidAmountError,
  TooManyDecimalsError,
  OverflowError,
} from './Money.js';

// Locale-aware amount parsing (spec 046)
export {
  parseLocaleAmount,
  type ParseLocaleAmountOptions,
  type ParsedLocaleAmount,
  type ParseFailureReason,
} from './parseLocaleAmount.js';
