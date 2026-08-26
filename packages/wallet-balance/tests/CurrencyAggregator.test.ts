/**
 * CurrencyAggregator Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CurrencyAggregator,
  registerCurrency,
  unregisterCurrency,
  getCurrencyConfig,
  isZeroDecimalCurrency,
} from '../src';

describe('CurrencyAggregator', () => {
  describe('getConfig', () => {
    it('should return config for known currency', () => {
      const config = CurrencyAggregator.getConfig('EUR');
      expect(config.code).toBe('EUR');
      expect(config.symbol).toBe('\u20AC');
      expect(config.decimals).toBe(2);
      expect(config.symbolPosition).toBe('before');
    });

    it('should return config for SAT', () => {
      const config = CurrencyAggregator.getConfig('SAT');
      expect(config.code).toBe('SAT');
      expect(config.symbol).toBe('sats');
      expect(config.decimals).toBe(0);
      expect(config.symbolPosition).toBe('after');
    });

    it('should return default config for unknown currency', () => {
      const config = CurrencyAggregator.getConfig('XYZ');
      expect(config.code).toBe('XYZ');
      expect(config.symbol).toBe('XYZ');
      expect(config.decimals).toBe(2);
    });

    it('should normalize currency code to uppercase', () => {
      const config = CurrencyAggregator.getConfig('eur');
      expect(config.code).toBe('EUR');
    });
  });

  describe('toMajorUnits', () => {
    it('should convert cents to euros', () => {
      expect(CurrencyAggregator.toMajorUnits(1500, 2)).toBe(15);
    });

    it('should leave sats unchanged (0 decimals)', () => {
      expect(CurrencyAggregator.toMajorUnits(1000, 0)).toBe(1000);
    });

    it('should handle 8 decimals (BTC)', () => {
      expect(CurrencyAggregator.toMajorUnits(100000000, 8)).toBe(1);
    });
  });

  describe('toMinorUnits', () => {
    it('should convert euros to cents', () => {
      expect(CurrencyAggregator.toMinorUnits(15, 2)).toBe(1500);
    });

    it('should round to nearest integer', () => {
      expect(CurrencyAggregator.toMinorUnits(15.555, 2)).toBe(1556);
    });

    it('should leave sats unchanged (0 decimals)', () => {
      expect(CurrencyAggregator.toMinorUnits(1000, 0)).toBe(1000);
    });
  });

  describe('format', () => {
    it('should format EUR with symbol before', () => {
      expect(CurrencyAggregator.format(1500, 'EUR')).toBe('\u20AC15,00');
    });

    it('should format USD with symbol before', () => {
      expect(CurrencyAggregator.format(1500, 'USD')).toBe('$15.00');
    });

    it('should format SAT with symbol after', () => {
      expect(CurrencyAggregator.format(1000, 'SAT')).toBe('1,000 sats');
    });

    it('should format XAF with symbol after and 0 decimals', () => {
      expect(CurrencyAggregator.format(5000, 'XAF')).toBe('5 000 FCFA');
    });

    it('should handle large numbers with thousands separator', () => {
      expect(CurrencyAggregator.format(123456789, 'SAT')).toBe('123,456,789 sats');
    });

    it('should handle zero', () => {
      expect(CurrencyAggregator.format(0, 'EUR')).toBe('\u20AC0,00');
    });

    it('should override decimals when specified', () => {
      expect(CurrencyAggregator.format(15000, 'EUR', 3)).toBe('\u20AC15,000');
    });
  });

  describe('formatMultiple', () => {
    it('should format multiple currencies', () => {
      const balances = [
        { currency: 'EUR', amount: 1000, decimals: 2, formatted: '', voucherCount: 1 },
        { currency: 'USD', amount: 500, decimals: 2, formatted: '', voucherCount: 1 },
      ];
      const result = CurrencyAggregator.formatMultiple(balances);
      expect(result).toContain('\u20AC10,00');
      expect(result).toContain('$5.00');
      expect(result).toContain(' + ');
    });

    it('should sort by amount descending', () => {
      const balances = [
        { currency: 'USD', amount: 500, decimals: 2, formatted: '', voucherCount: 1 },
        { currency: 'EUR', amount: 1000, decimals: 2, formatted: '', voucherCount: 1 },
      ];
      const result = CurrencyAggregator.formatMultiple(balances);
      // EUR should come first (higher amount)
      expect(result.indexOf('\u20AC')).toBeLessThan(result.indexOf('$'));
    });

    it('should handle empty array', () => {
      expect(CurrencyAggregator.formatMultiple([])).toBe('');
    });

    it('should use custom separator', () => {
      const balances = [
        { currency: 'EUR', amount: 1000, decimals: 2, formatted: '', voucherCount: 1 },
        { currency: 'USD', amount: 500, decimals: 2, formatted: '', voucherCount: 1 },
      ];
      const result = CurrencyAggregator.formatMultiple(balances, ' | ');
      expect(result).toContain(' | ');
    });
  });

  describe('aggregate', () => {
    it('should aggregate amounts by currency', () => {
      const items = [
        { amount: 1000, currency: 'EUR' },
        { amount: 500, currency: 'EUR' },
        { amount: 200, currency: 'USD' },
      ];
      const result = CurrencyAggregator.aggregate(items);

      expect(result).toHaveLength(2);
      const eur = result.find(b => b.currency === 'EUR');
      const usd = result.find(b => b.currency === 'USD');

      expect(eur?.amount).toBe(1500);
      expect(eur?.voucherCount).toBe(2);
      expect(usd?.amount).toBe(200);
      expect(usd?.voucherCount).toBe(1);
    });

    it('should normalize currency codes', () => {
      const items = [
        { amount: 1000, currency: 'eur' },
        { amount: 500, currency: 'EUR' },
      ];
      const result = CurrencyAggregator.aggregate(items);

      expect(result).toHaveLength(1);
      expect(result[0].currency).toBe('EUR');
      expect(result[0].amount).toBe(1500);
    });

    it('should sort by amount descending', () => {
      const items = [
        { amount: 100, currency: 'USD' },
        { amount: 1000, currency: 'EUR' },
      ];
      const result = CurrencyAggregator.aggregate(items);

      expect(result[0].currency).toBe('EUR');
      expect(result[1].currency).toBe('USD');
    });
  });

  describe('createBalance', () => {
    it('should create a CurrencyBalance object', () => {
      const balance = CurrencyAggregator.createBalance('EUR', 1500, 3);

      expect(balance.currency).toBe('EUR');
      expect(balance.amount).toBe(1500);
      expect(balance.decimals).toBe(2);
      expect(balance.voucherCount).toBe(3);
      expect(balance.formatted).toBe('\u20AC15,00');
    });

    it('should use default voucher count of 0', () => {
      const balance = CurrencyAggregator.createBalance('EUR', 1000);
      expect(balance.voucherCount).toBe(0);
    });
  });

  describe('findPrimary', () => {
    it('should find currency with highest amount', () => {
      const balances = [
        { currency: 'USD', amount: 500, decimals: 2, formatted: '', voucherCount: 1 },
        { currency: 'EUR', amount: 1000, decimals: 2, formatted: '', voucherCount: 1 },
        { currency: 'SAT', amount: 100, decimals: 0, formatted: '', voucherCount: 1 },
      ];
      expect(CurrencyAggregator.findPrimary(balances)).toBe('EUR');
    });

    it('should return null for empty array', () => {
      expect(CurrencyAggregator.findPrimary([])).toBeNull();
    });
  });

  describe('registerCurrency', () => {
    afterEach(() => {
      unregisterCurrency('TEST');
    });

    it('should register a custom currency', () => {
      registerCurrency('TEST', {
        symbol: 'T$',
        decimals: 3,
        symbolPosition: 'before',
      });

      const config = getCurrencyConfig('TEST');
      expect(config.code).toBe('TEST');
      expect(config.symbol).toBe('T$');
      expect(config.decimals).toBe(3);
    });

    it('should allow formatting with custom currency', () => {
      registerCurrency('TEST', {
        symbol: 'T$',
        decimals: 2,
        symbolPosition: 'before',
      });

      expect(CurrencyAggregator.format(1000, 'TEST')).toBe('T$10.00');
    });
  });

  describe('isZeroDecimalCurrency', () => {
    it('should return true for SAT', () => {
      expect(isZeroDecimalCurrency('SAT')).toBe(true);
    });

    it('should return true for XAF', () => {
      expect(isZeroDecimalCurrency('XAF')).toBe(true);
    });

    it('should return false for EUR', () => {
      expect(isZeroDecimalCurrency('EUR')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isZeroDecimalCurrency('sat')).toBe(true);
    });
  });

  describe('arithmetic operations', () => {
    it('should add amounts', () => {
      const result = CurrencyAggregator.add(
        { amount: 100, currency: 'EUR' },
        { amount: 50, currency: 'EUR' }
      );
      expect(result.amount).toBe(150);
      expect(result.currency).toBe('EUR');
    });

    it('should throw when adding different currencies', () => {
      expect(() => CurrencyAggregator.add(
        { amount: 100, currency: 'EUR' },
        { amount: 50, currency: 'USD' }
      )).toThrow('Cannot add amounts in different currencies');
    });

    it('should subtract amounts', () => {
      const result = CurrencyAggregator.subtract(
        { amount: 100, currency: 'EUR' },
        { amount: 30, currency: 'EUR' }
      );
      expect(result.amount).toBe(70);
    });

    it('should check if positive', () => {
      expect(CurrencyAggregator.isPositive({ amount: 100, currency: 'EUR' })).toBe(true);
      expect(CurrencyAggregator.isPositive({ amount: 0, currency: 'EUR' })).toBe(false);
      expect(CurrencyAggregator.isPositive({ amount: -100, currency: 'EUR' })).toBe(false);
    });

    it('should check if zero', () => {
      expect(CurrencyAggregator.isZero({ amount: 0, currency: 'EUR' })).toBe(true);
      expect(CurrencyAggregator.isZero({ amount: 100, currency: 'EUR' })).toBe(false);
    });

    it('should get absolute value', () => {
      const result = CurrencyAggregator.abs({ amount: -100, currency: 'EUR' });
      expect(result.amount).toBe(100);
    });
  });
});
