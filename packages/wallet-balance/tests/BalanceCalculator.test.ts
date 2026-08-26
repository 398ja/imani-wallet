/**
 * BalanceCalculator Tests
 */

import { describe, it, expect } from 'vitest';
import { BalanceCalculator, type BalanceVoucher } from '../src';

// Test fixtures
function createVoucher(overrides: Partial<BalanceVoucher> = {}): BalanceVoucher {
  return {
    id: `voucher-${Math.random().toString(36).slice(2)}`,
    faceValue: 1000,
    faceUnit: 'EUR',
    faceDecimals: 2,
    tokenAmount: 100,
    tokenUnit: 'sat',
    status: 'active',
    ...overrides,
  };
}

describe('BalanceCalculator', () => {
  describe('calculateTotal', () => {
    it('should calculate total balance from vouchers', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
        createVoucher({ faceValue: 500, faceUnit: 'EUR' }),
        createVoucher({ faceValue: 200, faceUnit: 'USD' }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers);

      expect(balance.currencies.EUR.amount).toBe(1500);
      expect(balance.currencies.EUR.voucherCount).toBe(2);
      expect(balance.currencies.USD.amount).toBe(200);
      expect(balance.currencies.USD.voucherCount).toBe(1);
    });

    it('should calculate total sats backing', () => {
      const vouchers = [
        createVoucher({ tokenAmount: 100 }),
        createVoucher({ tokenAmount: 200 }),
        createVoucher({ tokenAmount: 50 }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.totalSatsBacking).toBe(350);
    });

    it('should exclude non-active vouchers', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, status: 'active' }),
        createVoucher({ faceValue: 500, status: 'spent' }),
        createVoucher({ faceValue: 200, status: 'expired' }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.currencies.EUR.amount).toBe(1000);
      expect(balance.currencies.EUR.voucherCount).toBe(1);
    });

    it('should exclude expired vouchers', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const vouchers = [
        createVoucher({ faceValue: 1000, expiresAt: tomorrow }),
        createVoucher({ faceValue: 500, expiresAt: yesterday }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.currencies.EUR.amount).toBe(1000);
    });

    it('should include vouchers without expiry', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, expiresAt: undefined }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.currencies.EUR.amount).toBe(1000);
    });

    it('should return empty balance for empty array', () => {
      const balance = BalanceCalculator.calculateTotal([]);

      expect(Object.keys(balance.currencies)).toHaveLength(0);
      expect(balance.totalSatsBacking).toBe(0);
      expect(balance.primaryCurrency).toBeNull();
    });

    // =========================================================================
    // Feature 007-fix-voucher-currency — US3 aggregator vectors
    // =========================================================================
    it('US3-a: sums two vouchers with the same currency', () => {
      const vouchers = [
        createVoucher({ faceValue: 100, faceUnit: 'USD' }),
        createVoucher({ faceValue: 200, faceUnit: 'USD' }),
      ];
      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.currencies.USD.amount).toBe(300);
    });

    it('US3-b: merges mixed casing into one tile', () => {
      const vouchers = [
        createVoucher({ faceValue: 100, faceUnit: 'usd' }),
        createVoucher({ faceValue: 200, faceUnit: 'USD' }),
      ];
      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.currencies.USD?.amount).toBe(300);
      expect(balance.currencies.usd).toBeUndefined();
    });

    it('US3-c: UNKNOWN yields its own tile, never rolled into SAT', () => {
      const vouchers = [
        createVoucher({ faceValue: 100, faceUnit: 'SAT' }),
        createVoucher({ faceValue: 500, faceUnit: 'UNKNOWN' }),
      ];
      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.currencies.SAT?.amount).toBe(100);
      expect(balance.currencies.UNKNOWN?.amount).toBe(500);
    });

    it('US3-d: null / empty face_unit becomes UNKNOWN, not SAT', () => {
      const vouchers = [
        createVoucher({ faceValue: 100, faceUnit: 'SAT' }),
        createVoucher({ faceValue: 50, faceUnit: '' as string }),
        createVoucher({ faceValue: 25, faceUnit: '   ' as string }),
      ];
      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.currencies.SAT?.amount).toBe(100);
      expect(balance.currencies.UNKNOWN?.amount).toBe(75);
    });

    it('should identify primary currency', () => {
      const vouchers = [
        createVoucher({ faceValue: 100, faceUnit: 'USD' }),
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers);
      expect(balance.primaryCurrency).toBe('EUR');
    });

    it('should set calculatedAt timestamp', () => {
      const before = Date.now();
      const balance = BalanceCalculator.calculateTotal([createVoucher()]);
      const after = Date.now();

      expect(balance.calculatedAt).toBeGreaterThanOrEqual(before);
      expect(balance.calculatedAt).toBeLessThanOrEqual(after);
    });
  });

  describe('calculateTotal with options', () => {
    it('should filter by issuer', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, issuerId: 'issuer-1' }),
        createVoucher({ faceValue: 500, issuerId: 'issuer-2' }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers, { issuerId: 'issuer-1' });
      expect(balance.currencies.EUR.amount).toBe(1000);
    });

    it('should filter by currency', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
        createVoucher({ faceValue: 500, faceUnit: 'USD' }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers, { currency: 'EUR' });
      expect(balance.currencies.EUR.amount).toBe(1000);
      expect(balance.currencies.USD).toBeUndefined();
    });

    it('should filter by backing strategy', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, backingStrategy: 'MINIMAL' }),
        createVoucher({ faceValue: 500, backingStrategy: 'FULL' }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers, { backingStrategy: 'MINIMAL' });
      expect(balance.currencies.EUR.amount).toBe(1000);
    });

    it('should filter by expiring within days', () => {
      const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const in10Days = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

      const vouchers = [
        createVoucher({ faceValue: 1000, expiresAt: in3Days }),
        createVoucher({ faceValue: 500, expiresAt: in10Days }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers, { expiringWithinDays: 7 });
      expect(balance.currencies.EUR.amount).toBe(1000);
    });

    it('should allow including non-active when activeOnly=false', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, status: 'active' }),
        createVoucher({ faceValue: 500, status: 'spent' }),
      ];

      const balance = BalanceCalculator.calculateTotal(vouchers, { activeOnly: false });
      expect(balance.currencies.EUR.amount).toBe(1500);
    });
  });

  describe('calculateForCurrency', () => {
    it('should calculate balance for specific currency', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
        createVoucher({ faceValue: 500, faceUnit: 'EUR' }),
        createVoucher({ faceValue: 200, faceUnit: 'USD' }),
      ];

      const eurBalance = BalanceCalculator.calculateForCurrency(vouchers, 'EUR');
      expect(eurBalance?.amount).toBe(1500);
      expect(eurBalance?.voucherCount).toBe(2);
    });

    it('should return null for non-existent currency', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
      ];

      const balance = BalanceCalculator.calculateForCurrency(vouchers, 'GBP');
      expect(balance).toBeNull();
    });

    it('should be case-insensitive', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
      ];

      const balance = BalanceCalculator.calculateForCurrency(vouchers, 'eur');
      expect(balance?.amount).toBe(1000);
    });
  });

  describe('calculateByIssuer', () => {
    it('should group balances by issuer', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, issuerId: 'issuer-1', issuerName: 'Issuer One' }),
        createVoucher({ faceValue: 500, issuerId: 'issuer-1', issuerName: 'Issuer One' }),
        createVoucher({ faceValue: 200, issuerId: 'issuer-2', issuerName: 'Issuer Two' }),
      ];

      const issuers = BalanceCalculator.calculateByIssuer(vouchers);

      expect(issuers).toHaveLength(2);

      const issuer1 = issuers.find(i => i.issuerId === 'issuer-1');
      expect(issuer1?.currencies.EUR.amount).toBe(1500);
      expect(issuer1?.issuerName).toBe('Issuer One');
      expect(issuer1?.voucherCount).toBe(2);

      const issuer2 = issuers.find(i => i.issuerId === 'issuer-2');
      expect(issuer2?.currencies.EUR.amount).toBe(200);
    });

    it('should handle multiple currencies per issuer', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, faceUnit: 'EUR', issuerId: 'issuer-1' }),
        createVoucher({ faceValue: 500, faceUnit: 'USD', issuerId: 'issuer-1' }),
      ];

      const issuers = BalanceCalculator.calculateByIssuer(vouchers);

      expect(issuers).toHaveLength(1);
      expect(issuers[0].currencies.EUR.amount).toBe(1000);
      expect(issuers[0].currencies.USD.amount).toBe(500);
    });

    it('should sort by sats backing descending', () => {
      const vouchers = [
        createVoucher({ tokenAmount: 100, issuerId: 'issuer-1' }),
        createVoucher({ tokenAmount: 500, issuerId: 'issuer-2' }),
      ];

      const issuers = BalanceCalculator.calculateByIssuer(vouchers);

      expect(issuers[0].issuerId).toBe('issuer-2');
      expect(issuers[1].issuerId).toBe('issuer-1');
    });

    it('should use unknown for missing issuer', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, issuerId: undefined }),
      ];

      const issuers = BalanceCalculator.calculateByIssuer(vouchers);

      expect(issuers[0].issuerId).toBe('unknown');
      expect(issuers[0].issuerName).toBe('Unknown');
    });
  });

  describe('calculateByStrategy', () => {
    it('should group by backing strategy', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, backingStrategy: 'MINIMAL' }),
        createVoucher({ faceValue: 500, backingStrategy: 'FULL' }),
        createVoucher({ faceValue: 200, backingStrategy: 'LEGACY' }),
      ];

      const byStrategy = BalanceCalculator.calculateByStrategy(vouchers);

      expect(byStrategy.MINIMAL.currencies.EUR.amount).toBe(1000);
      expect(byStrategy.FULL.currencies.EUR.amount).toBe(500);
      expect(byStrategy.LEGACY.currencies.EUR.amount).toBe(200);
    });
  });

  describe('calculateBreakdown', () => {
    it('should return full breakdown', () => {
      const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

      const vouchers = [
        createVoucher({ faceValue: 1000, issuerId: 'issuer-1', backingStrategy: 'MINIMAL' }),
        createVoucher({ faceValue: 500, issuerId: 'issuer-2', backingStrategy: 'FULL', expiresAt: in3Days }),
      ];

      const breakdown = BalanceCalculator.calculateBreakdown(vouchers);

      expect(breakdown.total.currencies.EUR.amount).toBe(1500);
      expect(breakdown.byIssuer).toHaveLength(2);
      expect(breakdown.byStrategy.MINIMAL.currencies.EUR.amount).toBe(1000);
      expect(breakdown.expiringSoon.currencies.EUR.amount).toBe(500);
    });
  });

  describe('mergeBalances', () => {
    it('should merge multiple balances', () => {
      const balance1 = BalanceCalculator.calculateTotal([
        createVoucher({ faceValue: 1000, faceUnit: 'EUR', tokenAmount: 100 }),
      ]);
      const balance2 = BalanceCalculator.calculateTotal([
        createVoucher({ faceValue: 500, faceUnit: 'EUR', tokenAmount: 50 }),
        createVoucher({ faceValue: 200, faceUnit: 'USD', tokenAmount: 20 }),
      ]);

      const merged = BalanceCalculator.mergeBalances(balance1, balance2);

      expect(merged.currencies.EUR.amount).toBe(1500);
      expect(merged.currencies.EUR.voucherCount).toBe(2);
      expect(merged.currencies.USD.amount).toBe(200);
      expect(merged.totalSatsBacking).toBe(170);
    });

    it('should return empty balance for no arguments', () => {
      const merged = BalanceCalculator.mergeBalances();

      expect(Object.keys(merged.currencies)).toHaveLength(0);
      expect(merged.totalSatsBacking).toBe(0);
    });
  });

  describe('subtractFromBalance', () => {
    it('should subtract amount from currency', () => {
      const balance = BalanceCalculator.calculateTotal([
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
      ]);

      const result = BalanceCalculator.subtractFromBalance(balance, 'EUR', 300);

      expect(result.currencies.EUR.amount).toBe(700);
    });

    it('should not go negative', () => {
      const balance = BalanceCalculator.calculateTotal([
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
      ]);

      const result = BalanceCalculator.subtractFromBalance(balance, 'EUR', 2000);

      expect(result.currencies.EUR).toBeUndefined();
    });

    it('should not affect other currencies', () => {
      const balance = BalanceCalculator.calculateTotal([
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
        createVoucher({ faceValue: 500, faceUnit: 'USD' }),
      ]);

      const result = BalanceCalculator.subtractFromBalance(balance, 'EUR', 300);

      expect(result.currencies.EUR.amount).toBe(700);
      expect(result.currencies.USD.amount).toBe(500);
    });

    it('should return unchanged if currency not present', () => {
      const balance = BalanceCalculator.calculateTotal([
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
      ]);

      const result = BalanceCalculator.subtractFromBalance(balance, 'GBP', 300);

      expect(result.currencies.EUR.amount).toBe(1000);
    });
  });

  describe('utility methods', () => {
    it('hasBalance should check if any currency has value', () => {
      const withBalance = BalanceCalculator.calculateTotal([createVoucher()]);
      const empty = BalanceCalculator.calculateTotal([]);

      expect(BalanceCalculator.hasBalance(withBalance)).toBe(true);
      expect(BalanceCalculator.hasBalance(empty)).toBe(false);
    });

    it('hasCurrency should check specific currency', () => {
      const balance = BalanceCalculator.calculateTotal([
        createVoucher({ faceUnit: 'EUR' }),
      ]);

      expect(BalanceCalculator.hasCurrency(balance, 'EUR')).toBe(true);
      expect(BalanceCalculator.hasCurrency(balance, 'USD')).toBe(false);
    });

    it('getAmount should return amount or 0', () => {
      const balance = BalanceCalculator.calculateTotal([
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
      ]);

      expect(BalanceCalculator.getAmount(balance, 'EUR')).toBe(1000);
      expect(BalanceCalculator.getAmount(balance, 'USD')).toBe(0);
    });

    it('equals should compare balances', () => {
      const vouchers = [createVoucher({ faceValue: 1000 })];
      const balance1 = BalanceCalculator.calculateTotal(vouchers);
      const balance2 = BalanceCalculator.calculateTotal(vouchers);
      const balance3 = BalanceCalculator.calculateTotal([createVoucher({ faceValue: 500 })]);

      expect(BalanceCalculator.equals(balance1, balance2)).toBe(true);
      expect(BalanceCalculator.equals(balance1, balance3)).toBe(false);
    });
  });
});
