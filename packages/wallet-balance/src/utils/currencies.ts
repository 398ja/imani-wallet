/**
 * Currency Configurations
 *
 * Pre-defined configurations for known currencies.
 * Unknown currencies use sensible defaults.
 */

import type { CurrencyConfig } from '../types';

/**
 * Known currency configurations
 */
export const CURRENCY_CONFIGS: Record<string, CurrencyConfig> = {
  // Major Fiat - 2 decimals
  EUR: {
    code: 'EUR',
    symbol: '\u20AC',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ' ',
    decimalSeparator: ',',
  },
  USD: {
    code: 'USD',
    symbol: '$',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  GBP: {
    code: 'GBP',
    symbol: '\u00A3',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  CHF: {
    code: 'CHF',
    symbol: 'CHF',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: "'",
    decimalSeparator: '.',
  },
  CAD: {
    code: 'CAD',
    symbol: 'C$',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  AUD: {
    code: 'AUD',
    symbol: 'A$',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  MXN: {
    code: 'MXN',
    symbol: '$',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  BRL: {
    code: 'BRL',
    symbol: 'R$',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: '.',
    decimalSeparator: ',',
  },

  // African currencies - mostly 0 decimals
  XAF: {
    code: 'XAF',
    symbol: 'FCFA',
    decimals: 0,
    symbolPosition: 'after',
    thousandsSeparator: ' ',
    decimalSeparator: '.',
  },
  XOF: {
    code: 'XOF',
    symbol: 'FCFA',
    decimals: 0,
    symbolPosition: 'after',
    thousandsSeparator: ' ',
    decimalSeparator: '.',
  },
  NGN: {
    code: 'NGN',
    symbol: '\u20A6',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  KES: {
    code: 'KES',
    symbol: 'KSh',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  ZAR: {
    code: 'ZAR',
    symbol: 'R',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ' ',
    decimalSeparator: ',',
  },
  GHS: {
    code: 'GHS',
    symbol: '\u20B5',
    decimals: 2,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  UGX: {
    code: 'UGX',
    symbol: 'USh',
    decimals: 0,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  TZS: {
    code: 'TZS',
    symbol: 'TSh',
    decimals: 0,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },

  // Crypto
  SAT: {
    code: 'SAT',
    symbol: 'sats',
    decimals: 0,
    symbolPosition: 'after',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  SATS: {
    code: 'SATS',
    symbol: 'sats',
    decimals: 0,
    symbolPosition: 'after',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  BTC: {
    code: 'BTC',
    symbol: '\u20BF',
    decimals: 8,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },

  // Zero-decimal fiat
  JPY: {
    code: 'JPY',
    symbol: '\u00A5',
    decimals: 0,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
  KRW: {
    code: 'KRW',
    symbol: '\u20A9',
    decimals: 0,
    symbolPosition: 'before',
    thousandsSeparator: ',',
    decimalSeparator: '.',
  },
};

/**
 * Default configuration for unknown currencies
 */
export const DEFAULT_CURRENCY_CONFIG: CurrencyConfig = {
  code: 'UNKNOWN',
  symbol: '',
  decimals: 2,
  symbolPosition: 'after',
  thousandsSeparator: ',',
  decimalSeparator: '.',
};

/**
 * Zero-decimal currency codes
 */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'SAT',
  'SATS',
  'XAF',
  'XOF',
  'JPY',
  'KRW',
  'UGX',
  'TZS',
]);

/**
 * Custom currency registry for runtime registration
 */
const customCurrencies: Record<string, CurrencyConfig> = {};

/**
 * Register a custom currency configuration
 */
export function registerCurrency(code: string, config: Partial<CurrencyConfig>): void {
  const normalizedCode = code.toUpperCase();
  customCurrencies[normalizedCode] = {
    code: normalizedCode,
    symbol: config.symbol ?? normalizedCode,
    decimals: config.decimals ?? 2,
    symbolPosition: config.symbolPosition ?? 'after',
    thousandsSeparator: config.thousandsSeparator ?? ',',
    decimalSeparator: config.decimalSeparator ?? '.',
  };
}

/**
 * Unregister a custom currency
 */
export function unregisterCurrency(code: string): boolean {
  const normalizedCode = code.toUpperCase();
  if (customCurrencies[normalizedCode]) {
    delete customCurrencies[normalizedCode];
    return true;
  }
  return false;
}

/**
 * Get currency configuration
 */
export function getCurrencyConfig(code: string): CurrencyConfig {
  const normalizedCode = code.toUpperCase();

  // Check custom currencies first
  if (customCurrencies[normalizedCode]) {
    return customCurrencies[normalizedCode];
  }

  // Check built-in currencies
  if (CURRENCY_CONFIGS[normalizedCode]) {
    return CURRENCY_CONFIGS[normalizedCode];
  }

  // Return default with the currency code
  return {
    ...DEFAULT_CURRENCY_CONFIG,
    code: normalizedCode,
    symbol: normalizedCode,
  };
}

/**
 * Check if currency is zero-decimal
 */
export function isZeroDecimalCurrency(code: string): boolean {
  const normalizedCode = code.toUpperCase();
  return (
    ZERO_DECIMAL_CURRENCIES.has(normalizedCode) ||
    getCurrencyConfig(normalizedCode).decimals === 0
  );
}

/**
 * Get decimals for a currency
 */
export function getCurrencyDecimals(code: string): number {
  return getCurrencyConfig(code).decimals;
}

/**
 * Get all registered currency codes (built-in + custom)
 */
export function getAllCurrencyCodes(): string[] {
  return [
    ...Object.keys(CURRENCY_CONFIGS),
    ...Object.keys(customCurrencies),
  ];
}
