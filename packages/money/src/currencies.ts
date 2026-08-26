/**
 * Currency Registry
 *
 * Single source of truth for currency metadata across the entire Imani ecosystem.
 * Eliminates the 12+ duplicate zero-decimal currency lists scattered throughout the codebase.
 */

export interface CurrencyConfig {
  /** ISO 4217 code or custom code (SAT, SATS) */
  code: string;
  /** Display symbol (e.g., '$', 'FCFA', 'sats') */
  symbol: string;
  /** Number of decimal places (0 for SAT, XAF, JPY; 2 for EUR, USD; 8 for BTC) */
  decimals: number;
  /** Whether symbol appears before or after the amount */
  symbolPosition: 'before' | 'after';
  /** Thousands separator character */
  thousandsSeparator: string;
  /** Decimal separator character */
  decimalSeparator: string;
}

// ==========================================
// Built-in Currency Configurations
// ==========================================

const CURRENCIES: Record<string, CurrencyConfig> = {
  // Major Fiat - 2 decimals
  EUR: { code: 'EUR', symbol: '\u20AC', decimals: 2, symbolPosition: 'before', thousandsSeparator: ' ', decimalSeparator: ',' },
  USD: { code: 'USD', symbol: '$', decimals: 2, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  GBP: { code: 'GBP', symbol: '\u00A3', decimals: 2, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  CHF: { code: 'CHF', symbol: 'CHF', decimals: 2, symbolPosition: 'before', thousandsSeparator: "'", decimalSeparator: '.' },
  CAD: { code: 'CAD', symbol: 'C$', decimals: 2, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  AUD: { code: 'AUD', symbol: 'A$', decimals: 2, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  MXN: { code: 'MXN', symbol: '$', decimals: 2, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  BRL: { code: 'BRL', symbol: 'R$', decimals: 2, symbolPosition: 'before', thousandsSeparator: '.', decimalSeparator: ',' },

  // African currencies - 0 decimals
  XAF: { code: 'XAF', symbol: 'FCFA', decimals: 0, symbolPosition: 'after', thousandsSeparator: ' ', decimalSeparator: '.' },
  XOF: { code: 'XOF', symbol: 'FCFA', decimals: 0, symbolPosition: 'after', thousandsSeparator: ' ', decimalSeparator: '.' },
  CFA: { code: 'CFA', symbol: 'FCFA', decimals: 0, symbolPosition: 'after', thousandsSeparator: ' ', decimalSeparator: '.' },
  FCFA: { code: 'FCFA', symbol: 'FCFA', decimals: 0, symbolPosition: 'after', thousandsSeparator: ' ', decimalSeparator: '.' },

  // African currencies - 2 decimals
  NGN: { code: 'NGN', symbol: '\u20A6', decimals: 2, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  KES: { code: 'KES', symbol: 'KSh', decimals: 2, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  ZAR: { code: 'ZAR', symbol: 'R', decimals: 2, symbolPosition: 'before', thousandsSeparator: ' ', decimalSeparator: ',' },
  GHS: { code: 'GHS', symbol: '\u20B5', decimals: 2, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },

  // African currencies - 0 decimals
  UGX: { code: 'UGX', symbol: 'USh', decimals: 0, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  TZS: { code: 'TZS', symbol: 'TSh', decimals: 0, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },

  // Zero-decimal fiat
  JPY: { code: 'JPY', symbol: '\u00A5', decimals: 0, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  KRW: { code: 'KRW', symbol: '\u20A9', decimals: 0, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
  VND: { code: 'VND', symbol: '\u20AB', decimals: 0, symbolPosition: 'before', thousandsSeparator: '.', decimalSeparator: ',' },

  // Crypto
  SAT: { code: 'SAT', symbol: 'sats', decimals: 0, symbolPosition: 'after', thousandsSeparator: ',', decimalSeparator: '.' },
  SATS: { code: 'SATS', symbol: 'sats', decimals: 0, symbolPosition: 'after', thousandsSeparator: ',', decimalSeparator: '.' },
  BTC: { code: 'BTC', symbol: '\u20BF', decimals: 8, symbolPosition: 'before', thousandsSeparator: ',', decimalSeparator: '.' },
};

const DEFAULT_CONFIG: CurrencyConfig = {
  code: 'UNKNOWN',
  symbol: '',
  decimals: 2,
  symbolPosition: 'after',
  thousandsSeparator: ',',
  decimalSeparator: '.',
};

// Runtime-registered custom currencies
const customCurrencies: Record<string, CurrencyConfig> = {};

// ==========================================
// Public API
// ==========================================

/**
 * Get the full configuration for a currency code.
 * Returns a default (2-decimal) config for unknown currencies.
 */
export function getCurrency(code: string): CurrencyConfig {
  const normalized = code.toUpperCase();
  return customCurrencies[normalized]
    ?? CURRENCIES[normalized]
    ?? { ...DEFAULT_CONFIG, code: normalized, symbol: normalized };
}

/**
 * Get the number of decimal places for a currency.
 */
export function getDecimals(code: string): number {
  return getCurrency(code).decimals;
}

/**
 * Check if a currency uses zero decimal places.
 */
export function isZeroDecimal(code: string): boolean {
  return getDecimals(code) === 0;
}

/**
 * Check if the code represents a SAT-denominated currency.
 */
export function isSat(code: string): boolean {
  const normalized = code.toUpperCase();
  return normalized === 'SAT' || normalized === 'SATS';
}

/**
 * Register a custom currency at runtime.
 */
export function registerCurrency(code: string, config: Partial<CurrencyConfig>): void {
  const normalized = code.toUpperCase();
  customCurrencies[normalized] = {
    code: normalized,
    symbol: config.symbol ?? normalized,
    decimals: config.decimals ?? 2,
    symbolPosition: config.symbolPosition ?? 'after',
    thousandsSeparator: config.thousandsSeparator ?? ',',
    decimalSeparator: config.decimalSeparator ?? '.',
  };
}

/**
 * Get all known currency codes (built-in + custom).
 */
export function getAllCurrencyCodes(): string[] {
  return [...new Set([...Object.keys(CURRENCIES), ...Object.keys(customCurrencies)])];
}
