/**
 * Selection Module Tests
 *
 * Tests for VoucherGrouper and VoucherSelector.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VoucherGrouper,
  createVoucherGrouper,
  VoucherSelector,
  createVoucherSelector,
} from '../src/selection';
import type { Voucher } from '../src/types';
import type { StorageAdapter } from '../src/adapters';

// ============================================================================
// Test Fixtures
// ============================================================================

function createVoucher(overrides: Partial<Voucher> = {}): Voucher {
  return {
    voucher_id: `voucher-${Math.random().toString(36).slice(2, 9)}`,
    token: 'cashuAtest...',
    face_value: 1000,
    face_unit: 'SAT',
    face_decimals: 0,
    token_amount: 1000,
    token_unit: 'sat',
    backing_strategy: 'LEGACY',
    issuer_id: 'merchant1',
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createStorageAdapter(vouchers: Voucher[]): StorageAdapter {
  return {
    getVouchers: vi.fn().mockReturnValue(vouchers),
    getVoucher: vi.fn().mockImplementation((id) => vouchers.find((v) => v.voucher_id === id)),
    saveVoucher: vi.fn(),
    updateVoucher: vi.fn(),
    deleteVoucher: vi.fn(),
    getTransactions: vi.fn().mockReturnValue([]),
    saveTransaction: vi.fn(),
  };
}

// ============================================================================
// VoucherGrouper Tests
// ============================================================================

describe('VoucherGrouper', () => {
  describe('constructor', () => {
    it('creates with default config', () => {
      const grouper = new VoucherGrouper();
      expect(grouper).toBeInstanceOf(VoucherGrouper);
    });

    it('creates with custom config', () => {
      const grouper = new VoucherGrouper({
        includeExpired: true,
        includeSpent: true,
        includeZeroBalance: true,
      });
      expect(grouper).toBeInstanceOf(VoucherGrouper);
    });
  });

  describe('createVoucherGrouper', () => {
    it('creates grouper instance', () => {
      const grouper = createVoucherGrouper();
      expect(grouper).toBeInstanceOf(VoucherGrouper);
    });
  });

  describe('group()', () => {
    it('groups vouchers by merchant', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', face_value: 100 }),
        createVoucher({ issuer_id: 'merchant1', face_value: 200 }),
        createVoucher({ issuer_id: 'merchant2', face_value: 500 }),
      ];

      const groups = grouper.group(vouchers);

      expect(groups.size).toBe(2);
    });

    it('groups by unit as well', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', face_unit: 'SAT' }),
        createVoucher({ issuer_id: 'merchant1', face_unit: 'USD' }),
      ];

      const groups = grouper.group(vouchers);

      expect(groups.size).toBe(2);
    });

    it('groups by issuance ratio', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', backing_strategy: 'BACKED', issuance_ratio: 1 }),
        createVoucher({ issuer_id: 'merchant1', backing_strategy: 'BACKED', issuance_ratio: 0.9 }),
      ];

      const groups = grouper.group(vouchers);

      expect(groups.size).toBe(2);
    });

    it('calculates totals correctly', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({
          issuer_id: 'merchant1',
          face_value: 100,
          token_amount: 100,
        }),
        createVoucher({
          issuer_id: 'merchant1',
          face_value: 200,
          token_amount: 200,
        }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.totalFaceValue).toBe(300);
      expect(group.totalTokenAmount).toBe(300);
      expect(group.voucherCount).toBe(2);
    });

    it('sorts vouchers by face_value descending', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', face_value: 100 }),
        createVoucher({ issuer_id: 'merchant1', face_value: 500 }),
        createVoucher({ issuer_id: 'merchant1', face_value: 300 }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.vouchers[0].face_value).toBe(500);
      expect(group.vouchers[1].face_value).toBe(300);
      expect(group.vouchers[2].face_value).toBe(100);
    });

    it('returns empty map for empty input', () => {
      const grouper = new VoucherGrouper();
      const groups = grouper.group([]);

      expect(groups.size).toBe(0);
    });
  });

  describe('filtering', () => {
    it('excludes expired vouchers by default', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ status: 'active', face_value: 100 }),
        createVoucher({ status: 'expired', face_value: 200 }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.voucherCount).toBe(1);
      expect(group.totalFaceValue).toBe(100);
    });

    it('includes expired vouchers when configured', () => {
      const grouper = new VoucherGrouper({ includeExpired: true });
      const vouchers = [
        createVoucher({ status: 'active', face_value: 100 }),
        createVoucher({ status: 'expired', face_value: 200 }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.voucherCount).toBe(2);
    });

    it('excludes spent vouchers by default', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ status: 'active', face_value: 100 }),
        createVoucher({ status: 'spent', face_value: 200 }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.voucherCount).toBe(1);
    });

    it('includes spent vouchers when configured', () => {
      const grouper = new VoucherGrouper({ includeSpent: true });
      const vouchers = [
        createVoucher({ status: 'active', face_value: 100 }),
        createVoucher({ status: 'spent', face_value: 200 }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.voucherCount).toBe(2);
    });

    it('excludes zero-balance vouchers by default', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ face_value: 100, token_amount: 100 }),
        createVoucher({ face_value: 0, token_amount: 0 }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.voucherCount).toBe(1);
    });

    it('includes zero-balance vouchers when configured', () => {
      const grouper = new VoucherGrouper({ includeZeroBalance: true });
      const vouchers = [
        createVoucher({ face_value: 100, token_amount: 100 }),
        createVoucher({ face_value: 0, token_amount: 0 }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.voucherCount).toBe(2);
    });

    it('filters by expires_at date', () => {
      const grouper = new VoucherGrouper();
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      const futureDate = new Date(Date.now() + 86400000).toISOString();

      const vouchers = [
        createVoucher({ face_value: 100, expires_at: futureDate }),
        createVoucher({ face_value: 200, expires_at: pastDate }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.voucherCount).toBe(1);
      expect(group.totalFaceValue).toBe(100);
    });
  });

  describe('groupToArray()', () => {
    it('returns array of groups', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1' }),
        createVoucher({ issuer_id: 'merchant2' }),
      ];

      const groups = grouper.groupToArray(vouchers);

      expect(Array.isArray(groups)).toBe(true);
      expect(groups.length).toBe(2);
    });
  });

  describe('getGroupForMerchant()', () => {
    it('finds group by merchant ID', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', face_value: 100 }),
        createVoucher({ issuer_id: 'merchant2', face_value: 200 }),
      ];

      const group = grouper.getGroupForMerchant(vouchers, 'merchant1');

      expect(group).not.toBeNull();
      expect(group!.merchantId).toBe('merchant1');
      expect(group!.totalFaceValue).toBe(100);
    });

    it('returns null for unknown merchant', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [createVoucher({ issuer_id: 'merchant1' })];

      const group = grouper.getGroupForMerchant(vouchers, 'unknown');

      expect(group).toBeNull();
    });

    it('filters by unit when provided', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', face_unit: 'SAT', face_value: 100 }),
        createVoucher({ issuer_id: 'merchant1', face_unit: 'USD', face_value: 200 }),
      ];

      const group = grouper.getGroupForMerchant(vouchers, 'merchant1', 'USD');

      expect(group).not.toBeNull();
      expect(group!.unit).toBe('USD');
      expect(group!.totalFaceValue).toBe(200);
    });
  });

  describe('issuer ID normalization', () => {
    it('normalizes hex pubkeys to lowercase', () => {
      const grouper = new VoucherGrouper();
      const hexPubkey = 'A'.repeat(64);
      const vouchers = [
        createVoucher({ issuer_id: hexPubkey.toLowerCase() }),
        createVoucher({ issuer_id: hexPubkey.toUpperCase() }),
      ];

      const groups = grouper.group(vouchers);

      // Both should be in the same group
      expect(groups.size).toBe(1);
      const group = Array.from(groups.values())[0];
      expect(group.voucherCount).toBe(2);
    });

    it('handles npub addresses', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [
        createVoucher({ issuer_id: 'npub1test123' }),
      ];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.merchantId).toBe('npub1test123');
    });

    it('handles unknown issuer ID', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [createVoucher({ issuer_id: undefined })];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.merchantId).toBe('unknown');
    });
  });

  describe('currency handling', () => {
    it('uses 0 decimals for SAT', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [createVoucher({ face_unit: 'SAT' })];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.decimals).toBe(0);
    });

    it('uses 2 decimals for USD', () => {
      const grouper = new VoucherGrouper();
      // Don't pass face_decimals so it defaults to 2 for USD
      const vouchers = [createVoucher({ face_unit: 'USD', face_decimals: undefined })];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.decimals).toBe(2);
    });

    it('uses stored decimals when provided', () => {
      const grouper = new VoucherGrouper();
      const vouchers = [createVoucher({ face_unit: 'CUSTOM', face_decimals: 4 })];

      const groups = grouper.group(vouchers);
      const group = Array.from(groups.values())[0];

      expect(group.decimals).toBe(4);
    });
  });
});

// ============================================================================
// VoucherSelector Tests
// ============================================================================

describe('VoucherSelector', () => {
  describe('constructor', () => {
    it('creates with default config', () => {
      const selector = new VoucherSelector();
      expect(selector).toBeInstanceOf(VoucherSelector);
    });

    it('creates with storage adapter', () => {
      const storage = createStorageAdapter([]);
      const selector = new VoucherSelector({ storage });
      expect(selector).toBeInstanceOf(VoucherSelector);
    });
  });

  describe('createVoucherSelector', () => {
    it('creates selector instance', () => {
      const selector = createVoucherSelector();
      expect(selector).toBeInstanceOf(VoucherSelector);
    });
  });

  describe('selectFromGroup()', () => {
    let selector: VoucherSelector;

    beforeEach(() => {
      selector = new VoucherSelector();
    });

    it('selects voucher with sufficient balance', () => {
      const voucher = createVoucher({ face_value: 1000 });
      const group = {
        merchantId: 'merchant1',
        merchantName: 'Test Merchant',
        unit: 'SAT',
        decimals: 0,
        issuanceRatio: 1,
        totalFaceValue: 1000,
        totalTokenAmount: 1000,
        voucherCount: 1,
        vouchers: [voucher],
      };

      const result = selector.selectFromGroup(group, 500);

      expect(result.voucher).toBe(voucher);
      expect(result.needsConsolidation).toBe(false);
      expect(result.totalAvailable).toBe(1000);
      expect(result.merchantGroup).toBe(group);
    });

    it('selects exact match', () => {
      const voucher = createVoucher({ face_value: 500 });
      const group = {
        merchantId: 'merchant1',
        merchantName: 'Test Merchant',
        unit: 'SAT',
        decimals: 0,
        issuanceRatio: 1,
        totalFaceValue: 500,
        totalTokenAmount: 500,
        voucherCount: 1,
        vouchers: [voucher],
      };

      const result = selector.selectFromGroup(group, 500);

      expect(result.voucher.face_value).toBe(500);
    });

    it('throws when no voucher has sufficient balance', () => {
      const voucher = createVoucher({ face_value: 100 });
      const group = {
        merchantId: 'merchant1',
        merchantName: 'Test Merchant',
        unit: 'SAT',
        decimals: 0,
        issuanceRatio: 1,
        totalFaceValue: 100,
        totalTokenAmount: 100,
        voucherCount: 1,
        vouchers: [voucher],
      };

      expect(() => selector.selectFromGroup(group, 500)).toThrow();
    });

    it('throws for empty group', () => {
      const group = {
        merchantId: 'merchant1',
        merchantName: 'Test Merchant',
        unit: 'SAT',
        decimals: 0,
        issuanceRatio: 1,
        totalFaceValue: 0,
        totalTokenAmount: 0,
        voucherCount: 0,
        vouchers: [],
      };

      expect(() => selector.selectFromGroup(group, 100)).toThrow();
    });

    it('selects first sufficient voucher (sorted by value)', () => {
      // Vouchers should be sorted by face_value descending
      const vouchers = [
        createVoucher({ voucher_id: 'v1', face_value: 500 }),
        createVoucher({ voucher_id: 'v2', face_value: 300 }),
        createVoucher({ voucher_id: 'v3', face_value: 100 }),
      ];
      const group = {
        merchantId: 'merchant1',
        merchantName: 'Test Merchant',
        unit: 'SAT',
        decimals: 0,
        issuanceRatio: 1,
        totalFaceValue: 900,
        totalTokenAmount: 900,
        voucherCount: 3,
        vouchers,
      };

      const result = selector.selectFromGroup(group, 250);

      // Should pick the first voucher >= 250 (which is 500 since sorted desc)
      expect(result.voucher.face_value).toBeGreaterThanOrEqual(250);
    });
  });

  describe('getMerchantGroups()', () => {
    it('returns grouped vouchers from storage', async () => {
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1' }),
        createVoucher({ issuer_id: 'merchant2' }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const groups = await selector.getMerchantGroups();

      expect(groups.length).toBe(2);
      expect(storage.getVouchers).toHaveBeenCalledWith({ status: 'active' });
    });

    it('throws when no storage configured', async () => {
      const selector = new VoucherSelector();

      await expect(selector.getMerchantGroups()).rejects.toThrow('No storage adapter configured');
    });
  });

  describe('getMerchantGroup()', () => {
    it('returns specific merchant group', async () => {
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', face_value: 100 }),
        createVoucher({ issuer_id: 'merchant2', face_value: 200 }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const group = await selector.getMerchantGroup('merchant1');

      expect(group).not.toBeNull();
      expect(group!.merchantId).toBe('merchant1');
    });

    it('returns null for unknown merchant', async () => {
      const vouchers = [createVoucher({ issuer_id: 'merchant1' })];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const group = await selector.getMerchantGroup('unknown');

      expect(group).toBeNull();
    });
  });

  describe('selectByMerchant()', () => {
    it('selects voucher from merchant', async () => {
      const voucher = createVoucher({ issuer_id: 'merchant1', face_value: 1000 });
      const storage = createStorageAdapter([voucher]);
      const selector = new VoucherSelector({ storage });

      const result = await selector.selectByMerchant('merchant1', 500);

      expect(result.voucher).toEqual(voucher);
      expect(result.needsConsolidation).toBe(false);
    });

    it('throws for unknown merchant', async () => {
      const voucher = createVoucher({ issuer_id: 'merchant1' });
      const storage = createStorageAdapter([voucher]);
      const selector = new VoucherSelector({ storage });

      await expect(selector.selectByMerchant('unknown', 100)).rejects.toThrow();
    });

    it('filters by unit when provided', async () => {
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', face_unit: 'SAT', face_value: 100 }),
        createVoucher({ issuer_id: 'merchant1', face_unit: 'USD', face_value: 1000 }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const result = await selector.selectByMerchant('merchant1', 500, 'USD');

      expect(result.voucher.face_unit).toBe('USD');
    });
  });

  describe('selectByVoucherId()', () => {
    it('selects specific voucher', async () => {
      const voucher = createVoucher({ voucher_id: 'v123', face_value: 1000 });
      const storage = createStorageAdapter([voucher]);
      const selector = new VoucherSelector({ storage });

      const result = await selector.selectByVoucherId('v123', 500);

      expect(result.voucher.voucher_id).toBe('v123');
    });

    it('throws for unknown voucher', async () => {
      const storage = createStorageAdapter([]);
      const selector = new VoucherSelector({ storage });

      await expect(selector.selectByVoucherId('unknown', 100)).rejects.toThrow();
    });

    it('throws for insufficient balance', async () => {
      const voucher = createVoucher({ voucher_id: 'v123', face_value: 100 });
      const storage = createStorageAdapter([voucher]);
      const selector = new VoucherSelector({ storage });

      await expect(selector.selectByVoucherId('v123', 500)).rejects.toThrow();
    });
  });

  describe('findBestVoucher()', () => {
    it('finds exact match', async () => {
      const vouchers = [
        createVoucher({ face_value: 1000 }),
        createVoucher({ face_value: 500 }),
        createVoucher({ face_value: 200 }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const result = await selector.findBestVoucher(500);

      expect(result).not.toBeNull();
      expect(result!.voucher.face_value).toBe(500);
    });

    it('finds smallest sufficient voucher when no exact match', async () => {
      const vouchers = [
        createVoucher({ face_value: 1000 }),
        createVoucher({ face_value: 600 }),
        createVoucher({ face_value: 200 }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const result = await selector.findBestVoucher(500);

      expect(result).not.toBeNull();
      expect(result!.voucher.face_value).toBe(600);
    });

    it('returns null when no voucher has sufficient balance', async () => {
      const vouchers = [
        createVoucher({ face_value: 100 }),
        createVoucher({ face_value: 50 }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const result = await selector.findBestVoucher(500);

      expect(result).toBeNull();
    });

    it('filters by unit', async () => {
      const vouchers = [
        createVoucher({ face_value: 1000, face_unit: 'SAT' }),
        createVoucher({ face_value: 500, face_unit: 'USD' }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const result = await selector.findBestVoucher(400, 'USD');

      expect(result).not.toBeNull();
      expect(result!.voucher.face_unit).toBe('USD');
    });

    it('returns null when no voucher in requested unit', async () => {
      const vouchers = [
        createVoucher({ face_value: 1000, face_unit: 'SAT' }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const result = await selector.findBestVoucher(500, 'USD');

      expect(result).toBeNull();
    });

    it('searches across multiple merchants', async () => {
      const vouchers = [
        createVoucher({ issuer_id: 'merchant1', face_value: 100 }),
        createVoucher({ issuer_id: 'merchant2', face_value: 500 }),
        createVoucher({ issuer_id: 'merchant3', face_value: 200 }),
      ];
      const storage = createStorageAdapter(vouchers);
      const selector = new VoucherSelector({ storage });

      const result = await selector.findBestVoucher(300);

      expect(result).not.toBeNull();
      expect(result!.voucher.face_value).toBe(500);
    });
  });

  describe('validateAmount()', () => {
    it('returns true for sufficient balance', () => {
      const selector = new VoucherSelector();
      const voucher = createVoucher({ face_value: 1000 });

      expect(selector.validateAmount(voucher, 500)).toBe(true);
    });

    it('returns true for exact balance', () => {
      const selector = new VoucherSelector();
      const voucher = createVoucher({ face_value: 500 });

      expect(selector.validateAmount(voucher, 500)).toBe(true);
    });

    it('returns false for insufficient balance', () => {
      const selector = new VoucherSelector();
      const voucher = createVoucher({ face_value: 100 });

      expect(selector.validateAmount(voucher, 500)).toBe(false);
    });

    it('handles undefined face_value', () => {
      const selector = new VoucherSelector();
      const voucher = createVoucher({ face_value: undefined });

      expect(selector.validateAmount(voucher, 100)).toBe(false);
    });
  });
});
