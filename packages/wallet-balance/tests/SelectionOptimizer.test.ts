/**
 * SelectionOptimizer Tests
 */

import { describe, it, expect } from 'vitest';
import { SelectionOptimizer, type SelectableVoucher } from '../src';

// Test fixtures
function createVoucher(overrides: Partial<SelectableVoucher> = {}): SelectableVoucher {
  return {
    id: `voucher-${Math.random().toString(36).slice(2)}`,
    faceValue: 1000,
    faceUnit: 'EUR',
    faceDecimals: 2,
    tokenAmount: 100,
    tokenUnit: 'sat',
    issuanceRatio: 10,
    backingStrategy: 'MINIMAL',
    status: 'active',
    ...overrides,
  };
}

describe('SelectionOptimizer', () => {
  describe('selectForAmount', () => {
    it('should select single voucher when exact match', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 1000 }),
        createVoucher({ id: 'v2', faceValue: 500 }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
      });

      expect(result.vouchers).toHaveLength(1);
      expect(result.vouchers[0].id).toBe('v1');
      expect(result.totalAmount).toBe(1000);
      expect(result.changeAmount).toBe(0);
      expect(result.needsConsolidation).toBe(false);
      expect(result.sufficient).toBe(true);
    });

    it('should prefer single voucher with minimal overage', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 1500 }),
        createVoucher({ id: 'v2', faceValue: 1200 }),
        createVoucher({ id: 'v3', faceValue: 800 }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
      });

      expect(result.vouchers).toHaveLength(1);
      expect(result.vouchers[0].id).toBe('v2');
      expect(result.changeAmount).toBe(200);
    });

    it('should combine vouchers when needed', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 600 }),
        createVoucher({ id: 'v2', faceValue: 500 }),
        createVoucher({ id: 'v3', faceValue: 400 }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
      });

      expect(result.sufficient).toBe(true);
      expect(result.totalAmount).toBeGreaterThanOrEqual(1000);
      expect(result.needsConsolidation).toBe(true);
    });

    it('should handle insufficient balance', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 300 }),
        createVoucher({ id: 'v2', faceValue: 200 }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
      });

      expect(result.sufficient).toBe(false);
      expect(result.shortfall).toBe(500);
      expect(result.totalAmount).toBe(500);
    });

    it('should filter by currency', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 1000, faceUnit: 'EUR' }),
        createVoucher({ id: 'v2', faceValue: 2000, faceUnit: 'USD' }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1500,
        currency: 'EUR',
      });

      expect(result.sufficient).toBe(false);
      expect(result.vouchers.every(v => v.faceUnit === 'EUR')).toBe(true);
    });

    it('should exclude specified voucher IDs', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 1000 }),
        createVoucher({ id: 'v2', faceValue: 800 }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 800,
        currency: 'EUR',
        excludeVoucherIds: ['v1'],
      });

      expect(result.vouchers).toHaveLength(1);
      expect(result.vouchers[0].id).toBe('v2');
    });

    it('should prefer specified issuer', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 1000, issuerId: 'issuer-1' }),
        createVoucher({ id: 'v2', faceValue: 1000, issuerId: 'issuer-2' }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
        preferredIssuerId: 'issuer-2',
      });

      expect(result.vouchers[0].issuerId).toBe('issuer-2');
    });

    it('should exclude non-active vouchers', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 2000, status: 'spent' }),
        createVoucher({ id: 'v2', faceValue: 1000, status: 'active' }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1500,
        currency: 'EUR',
      });

      expect(result.sufficient).toBe(false);
      expect(result.vouchers.every(v => v.status === 'active')).toBe(true);
    });

    it('should exclude expired vouchers', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 2000, expiresAt: yesterday }),
        createVoucher({ id: 'v2', faceValue: 1000 }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1500,
        currency: 'EUR',
      });

      expect(result.sufficient).toBe(false);
      expect(result.vouchers).toHaveLength(1);
      expect(result.vouchers[0].id).toBe('v2');
    });
  });

  describe('minimize-change strategy', () => {
    it('should find optimal combination', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 1000 }),
        createVoucher({ id: 'v2', faceValue: 600 }),
        createVoucher({ id: 'v3', faceValue: 400 }),
        createVoucher({ id: 'v4', faceValue: 300 }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
        strategy: 'minimize-change',
      });

      expect(result.sufficient).toBe(true);
      // Should find exact match with single voucher
      expect(result.changeAmount).toBe(0);
    });

    it('should minimize overage when no exact match', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 700 }),
        createVoucher({ id: 'v2', faceValue: 600 }),
        createVoucher({ id: 'v3', faceValue: 400 }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
        strategy: 'minimize-change',
      });

      expect(result.sufficient).toBe(true);
      // Best is 600 + 400 = 1000
      expect(result.changeAmount).toBe(0);
    });
  });

  describe('use-expiring-first strategy', () => {
    it('should prioritize expiring vouchers', () => {
      const in2Days = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
      const in10Days = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 1000, expiresAt: in10Days }),
        createVoucher({ id: 'v2', faceValue: 1000, expiresAt: in2Days }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
        strategy: 'use-expiring-first',
        expiringWithinDays: 7,
      });

      expect(result.vouchers[0].id).toBe('v2');
    });

    it('should use non-expiring if expiring not sufficient', () => {
      const in2Days = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 800 }),
        createVoucher({ id: 'v2', faceValue: 500, expiresAt: in2Days }),
      ];

      const result = SelectionOptimizer.selectForAmount(vouchers, {
        amount: 1000,
        currency: 'EUR',
        strategy: 'use-expiring-first',
      });

      expect(result.sufficient).toBe(true);
      expect(result.vouchers.some(v => v.id === 'v2')).toBe(true);
    });
  });

  describe('findExactOrMinimalOverage', () => {
    it('should find exact match', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 500 }),
        createVoucher({ id: 'v2', faceValue: 1000 }),
        createVoucher({ id: 'v3', faceValue: 1500 }),
      ];

      const result = SelectionOptimizer.findExactOrMinimalOverage(vouchers, 1000, 'EUR');

      expect(result?.id).toBe('v2');
    });

    it('should find minimal overage', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 500 }),
        createVoucher({ id: 'v2', faceValue: 800 }),
        createVoucher({ id: 'v3', faceValue: 1200 }),
      ];

      const result = SelectionOptimizer.findExactOrMinimalOverage(vouchers, 1000, 'EUR');

      expect(result?.id).toBe('v3');
    });

    it('should return null if no voucher covers amount', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 500 }),
        createVoucher({ id: 'v2', faceValue: 300 }),
      ];

      const result = SelectionOptimizer.findExactOrMinimalOverage(vouchers, 1000, 'EUR');

      expect(result).toBeNull();
    });
  });

  describe('greedySelect', () => {
    it('should select largest first', () => {
      const vouchers = [
        createVoucher({ id: 'v1', faceValue: 300 }),
        createVoucher({ id: 'v2', faceValue: 500 }),
        createVoucher({ id: 'v3', faceValue: 400 }),
      ];

      const result = SelectionOptimizer.greedySelect(vouchers, 800);

      expect(result.vouchers[0].id).toBe('v2');
      expect(result.vouchers[1].id).toBe('v3');
    });
  });

  describe('canConsolidate', () => {
    it('should return true for compatible vouchers', () => {
      const vouchers = [
        createVoucher({
          issuerId: 'issuer-1',
          faceUnit: 'EUR',
          backingStrategy: 'MINIMAL',
          issuanceRatio: 10,
          expiresAt: '2025-01-01',
        }),
        createVoucher({
          issuerId: 'issuer-1',
          faceUnit: 'EUR',
          backingStrategy: 'MINIMAL',
          issuanceRatio: 10,
          expiresAt: '2025-01-01',
        }),
      ];

      expect(SelectionOptimizer.canConsolidate(vouchers)).toBe(true);
    });

    it('should return false for different issuers', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1' }),
        createVoucher({ issuerId: 'issuer-2' }),
      ];

      expect(SelectionOptimizer.canConsolidate(vouchers)).toBe(false);
    });

    it('should return false for different currencies', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1', faceUnit: 'EUR' }),
        createVoucher({ issuerId: 'issuer-1', faceUnit: 'USD' }),
      ];

      expect(SelectionOptimizer.canConsolidate(vouchers)).toBe(false);
    });

    it('should allow different backing strategies when issuer, currency, and expiry match', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1', backingStrategy: 'MINIMAL', expiresAt: '2025-01-01' }),
        createVoucher({ issuerId: 'issuer-1', backingStrategy: 'FULL', expiresAt: '2025-01-01' }),
      ];

      expect(SelectionOptimizer.canConsolidate(vouchers)).toBe(true);
    });

    it('should allow different issuance ratios when issuer, currency, and expiry match', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1', issuanceRatio: 10, expiresAt: '2025-01-01' }),
        createVoucher({ issuerId: 'issuer-1', issuanceRatio: 12.5, expiresAt: '2025-01-01' }),
      ];

      expect(SelectionOptimizer.canConsolidate(vouchers)).toBe(true);
    });

    it('should return false for different expiry dates', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1', expiresAt: '2025-01-01' }),
        createVoucher({ issuerId: 'issuer-1', expiresAt: '2025-02-01' }),
      ];

      expect(SelectionOptimizer.canConsolidate(vouchers)).toBe(false);
    });

    it('should return true for single voucher', () => {
      const vouchers = [createVoucher()];
      expect(SelectionOptimizer.canConsolidate(vouchers)).toBe(true);
    });

    it('should return true for empty array', () => {
      expect(SelectionOptimizer.canConsolidate([])).toBe(true);
    });
  });

  describe('groupForConsolidation', () => {
    it('should group compatible vouchers', () => {
      const vouchers = [
        createVoucher({ id: 'v1', issuerId: 'issuer-1', expiresAt: '2025-01-01' }),
        createVoucher({ id: 'v2', issuerId: 'issuer-1', expiresAt: '2025-01-01' }),
        createVoucher({ id: 'v3', issuerId: 'issuer-2', expiresAt: '2025-01-01' }),
      ];

      const groups = SelectionOptimizer.groupForConsolidation(vouchers);

      expect(groups).toHaveLength(2);
      expect(groups[0]).toHaveLength(2);
      expect(groups[1]).toHaveLength(1);
    });

    it('should return single group for all compatible', () => {
      const vouchers = [
        createVoucher({ id: 'v1', issuerId: 'issuer-1' }),
        createVoucher({ id: 'v2', issuerId: 'issuer-1' }),
        createVoucher({ id: 'v3', issuerId: 'issuer-1' }),
      ];

      const groups = SelectionOptimizer.groupForConsolidation(vouchers);

      expect(groups).toHaveLength(1);
      expect(groups[0]).toHaveLength(3);
    });
  });

  describe('checkConsolidation', () => {
    it('should return canConsolidate: true when all compatible', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1' }),
        createVoucher({ issuerId: 'issuer-1' }),
      ];

      const result = SelectionOptimizer.checkConsolidation(vouchers);

      expect(result.canConsolidate).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should return reason for different issuers', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1' }),
        createVoucher({ issuerId: 'issuer-2' }),
      ];

      const result = SelectionOptimizer.checkConsolidation(vouchers);

      expect(result.canConsolidate).toBe(false);
      expect(result.reason).toBe('Different issuers');
    });

    it('should return reason for different currencies', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1', faceUnit: 'EUR' }),
        createVoucher({ issuerId: 'issuer-1', faceUnit: 'USD' }),
      ];

      const result = SelectionOptimizer.checkConsolidation(vouchers);

      expect(result.canConsolidate).toBe(false);
      expect(result.reason).toBe('Different currencies');
    });

    it('should keep vouchers consolidatable across different backing strategies', () => {
      const vouchers = [
        createVoucher({ issuerId: 'issuer-1', backingStrategy: 'MINIMAL', expiresAt: '2025-01-01' }),
        createVoucher({ issuerId: 'issuer-1', backingStrategy: 'FULL', expiresAt: '2025-01-01' }),
      ];

      const result = SelectionOptimizer.checkConsolidation(vouchers);

      expect(result.canConsolidate).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('getTotalAvailable', () => {
    it('should calculate total available for currency', () => {
      const vouchers = [
        createVoucher({ faceValue: 1000, faceUnit: 'EUR' }),
        createVoucher({ faceValue: 500, faceUnit: 'EUR' }),
        createVoucher({ faceValue: 200, faceUnit: 'USD' }),
      ];

      expect(SelectionOptimizer.getTotalAvailable(vouchers, 'EUR')).toBe(1500);
      expect(SelectionOptimizer.getTotalAvailable(vouchers, 'USD')).toBe(200);
      expect(SelectionOptimizer.getTotalAvailable(vouchers, 'GBP')).toBe(0);
    });
  });
});
