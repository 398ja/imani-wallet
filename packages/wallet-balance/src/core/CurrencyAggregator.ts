/**
 * CurrencyAggregator
 *
 * Handles multi-currency aggregation and formatting.
 */

import type { CurrencyBalance, CurrencyConfig } from '../types';
import {
  getCurrencyConfig,
  getCurrencyDecimals,
  registerCurrency,
  unregisterCurrency,
  getAllCurrencyCodes,
  CURRENCY_CONFIGS,
  DEFAULT_CURRENCY_CONFIG,
} from '../utils/currencies';

/**
 * Amount with currency for aggregation
 */
export interface AmountWithCurrency {
  amount: number;
  currency: string;
  decimals?: number;
}

/**
 * Currency aggregation and formatting utilities
 */
export class CurrencyAggregator {
  /**
   * Known currency configurations (static reference)
   */
  static readonly CURRENCIES = CURRENCY_CONFIGS;

  /**
   * Default config for unknown currencies
   */
  static readonly DEFAULT_CONFIG = DEFAULT_CURRENCY_CONFIG;

  /**
   * Get currency configuration
   */
  static getConfig(currency: string): CurrencyConfig {
    return getCurrencyConfig(currency);
  }

  /**
   * Register a custom currency
   */
  static registerCurrency(code: string, config: Partial<CurrencyConfig>): void {
    registerCurrency(code, config);
  }

  /**
   * Unregister a custom currency
   */
  static unregisterCurrency(code: string): boolean {
    return unregisterCurrency(code);
  }

  /**
   * Get all registered currency codes
   */
  static getAllCurrencies(): string[] {
    return getAllCurrencyCodes();
  }

  /**
   * Convert minor units to major units
   * @param amount Amount in minor units (cents, satoshis)
   * @param decimals Decimal places
   */
  static toMajorUnits(amount: number, decimals: number): number {
    if (decimals === 0) {
      return amount;
    }
    const divisor = Math.pow(10, decimals);
    return amount / divisor;
  }

  /**
   * Convert major units to minor units
   * @param amount Amount in major units (euros, dollars)
   * @param decimals Decimal places
   */
  static toMinorUnits(amount: number, decimals: number): number {
    if (decimals === 0) {
      return Math.round(amount);
    }
    const multiplier = Math.pow(10, decimals);
    return Math.round(amount * multiplier);
  }

  /**
   * Format a number with thousands separator
   */
  static formatNumber(
    value: number,
    thousandsSeparator: string,
    decimalSeparator: string,
    decimalPlaces: number
  ): string {
    // Format with fixed decimals
    const fixed = value.toFixed(decimalPlaces);

    // Split into integer and decimal parts
    const [intPart, decPart] = fixed.split('.');

    // Add thousands separators to integer part
    const formattedInt = intPart.replace(
      /\B(?=(\d{3})+(?!\d))/g,
      thousandsSeparator
    );

    // Combine
    if (decimalPlaces === 0 || !decPart) {
      return formattedInt;
    }
    return `${formattedInt}${decimalSeparator}${decPart}`;
  }

  /**
   * Format amount for display
   * @param amount Amount in minor units
   * @param currency Currency code
   * @param decimalsOverride Override stored decimals (optional)
   */
  static format(
    amount: number,
    currency: string,
    decimalsOverride?: number
  ): string {
    const config = getCurrencyConfig(currency);
    const decimals = decimalsOverride ?? config.decimals;
    const majorAmount = this.toMajorUnits(amount, decimals);

    const formattedNumber = this.formatNumber(
      majorAmount,
      config.thousandsSeparator,
      config.decimalSeparator,
      decimals
    );

    if (config.symbolPosition === 'before') {
      return `${config.symbol}${formattedNumber}`;
    } else {
      return `${formattedNumber} ${config.symbol}`.trim();
    }
  }

  /**
   * Format multiple currency balances
   * @param balances Array of currency balances
   * @param separator Separator between currencies (default: ' + ')
   */
  static formatMultiple(
    balances: CurrencyBalance[],
    separator: string = ' + '
  ): string {
    if (balances.length === 0) {
      return '';
    }

    // Sort by amount descending (for consistent display)
    const sorted = [...balances].sort((a, b) => b.amount - a.amount);

    return sorted
      .map((b) => this.format(b.amount, b.currency, b.decimals))
      .join(separator);
  }

  /**
   * Aggregate amounts by currency
   */
  static aggregate(items: AmountWithCurrency[]): CurrencyBalance[] {
    const aggregated = new Map<string, { amount: number; decimals: number; count: number }>();

    for (const item of items) {
      const currency = item.currency.toUpperCase();
      const decimals = item.decimals ?? getCurrencyDecimals(currency);
      const existing = aggregated.get(currency);

      if (existing) {
        existing.amount += item.amount;
        existing.count++;
        // Keep the highest decimals if different
        if (decimals > existing.decimals) {
          existing.decimals = decimals;
        }
      } else {
        aggregated.set(currency, {
          amount: item.amount,
          decimals,
          count: 1,
        });
      }
    }

    const result: CurrencyBalance[] = [];
    for (const [currency, data] of aggregated) {
      result.push({
        currency,
        amount: data.amount,
        decimals: data.decimals,
        formatted: this.format(data.amount, currency, data.decimals),
        voucherCount: data.count,
      });
    }

    // Sort by amount descending
    return result.sort((a, b) => b.amount - a.amount);
  }

  /**
   * Compare two amounts in the same currency
   * Returns negative if a < b, positive if a > b, 0 if equal
   */
  static compare(a: AmountWithCurrency, b: AmountWithCurrency): number {
    if (a.currency.toUpperCase() !== b.currency.toUpperCase()) {
      throw new Error('Cannot compare amounts in different currencies');
    }
    return a.amount - b.amount;
  }

  /**
   * Add amounts (must be same currency)
   */
  static add(...amounts: AmountWithCurrency[]): AmountWithCurrency {
    if (amounts.length === 0) {
      throw new Error('At least one amount required');
    }

    const currency = amounts[0].currency.toUpperCase();
    let decimals = amounts[0].decimals ?? getCurrencyDecimals(currency);
    let total = 0;

    for (const amount of amounts) {
      if (amount.currency.toUpperCase() !== currency) {
        throw new Error('Cannot add amounts in different currencies');
      }
      total += amount.amount;
      const d = amount.decimals ?? getCurrencyDecimals(amount.currency);
      if (d > decimals) decimals = d;
    }

    return { amount: total, currency, decimals };
  }

  /**
   * Subtract amounts (must be same currency)
   */
  static subtract(
    from: AmountWithCurrency,
    ...amounts: AmountWithCurrency[]
  ): AmountWithCurrency {
    const currency = from.currency.toUpperCase();
    let decimals = from.decimals ?? getCurrencyDecimals(currency);
    let result = from.amount;

    for (const amount of amounts) {
      if (amount.currency.toUpperCase() !== currency) {
        throw new Error('Cannot subtract amounts in different currencies');
      }
      result -= amount.amount;
      const d = amount.decimals ?? getCurrencyDecimals(amount.currency);
      if (d > decimals) decimals = d;
    }

    return { amount: result, currency, decimals };
  }

  /**
   * Check if amount is positive
   */
  static isPositive(amount: AmountWithCurrency): boolean {
    return amount.amount > 0;
  }

  /**
   * Check if amount is zero
   */
  static isZero(amount: AmountWithCurrency): boolean {
    return amount.amount === 0;
  }

  /**
   * Check if amount is negative
   */
  static isNegative(amount: AmountWithCurrency): boolean {
    return amount.amount < 0;
  }

  /**
   * Get the absolute value
   */
  static abs(amount: AmountWithCurrency): AmountWithCurrency {
    return {
      ...amount,
      amount: Math.abs(amount.amount),
    };
  }

  /**
   * Find the primary currency (highest value)
   */
  static findPrimary(balances: CurrencyBalance[]): string | null {
    if (balances.length === 0) {
      return null;
    }

    // Sort by amount descending and return first
    const sorted = [...balances].sort((a, b) => b.amount - a.amount);
    return sorted[0].currency;
  }

  /**
   * Create a CurrencyBalance object
   */
  static createBalance(
    currency: string,
    amount: number,
    voucherCount: number = 0,
    decimalsOverride?: number
  ): CurrencyBalance {
    const decimals = decimalsOverride ?? getCurrencyDecimals(currency);
    return {
      currency: currency.toUpperCase(),
      amount,
      decimals,
      formatted: this.format(amount, currency, decimals),
      voucherCount,
    };
  }
}
