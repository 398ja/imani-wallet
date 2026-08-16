/**
 * @imani/wallet-balance
 *
 * Balance calculation and aggregation for Imani wallet.
 */

// Types
export * from './types';

// Core
export * from './core';

// Utils
export {
  getCurrencyConfig,
  getCurrencyDecimals,
  registerCurrency,
  unregisterCurrency,
  getAllCurrencyCodes,
  isZeroDecimalCurrency,
  CURRENCY_CONFIGS,
  DEFAULT_CURRENCY_CONFIG,
  ZERO_DECIMAL_CURRENCIES,
} from './utils/currencies';

export { TypedEventEmitter } from './utils/EventEmitter';

// Adapters
export type {
  ExchangeRateAdapter,
  UnifiedTotalInput,
  UnifiedTotalOutput,
  VoucherBucket,
} from './adapters/ExchangeRateAdapter';
