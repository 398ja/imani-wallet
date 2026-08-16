/**
 * Types and helper functions tests
 */

import { describe, it, expect } from 'vitest';
import {
  VoucherStatus,
  BackingStrategy,
  createVoucher,
  isVoucherExpired,
  fromAutoRedemptionVoucher,
  normalizeFilter,
  matchesFilter,
  sortVouchers,
  paginateVouchers,
  generateGroupKey,
  canConsolidate,
  type VoucherInput,
  type Voucher,
} from '../src';

describe('Types and Helpers', () => {
  describe('createVoucher', () => {
    it('should create a voucher with defaults', () => {
      const input: VoucherInput = {
        token: 'cashuAbc...',
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 10000,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'issuer-123',
        mintUrl: 'https://mint.example.com',
      };

      const voucher = createVoucher(input);

      expect(voucher.id).toBeDefined();
      expect(voucher.faceValue).toBe(100);
      expect(voucher.faceUnit).toBe('USD');
      expect(voucher.tokenAmount).toBe(10000);
      expect(voucher.status).toBe(VoucherStatus.ACTIVE);
      expect(voucher.synced).toBe(false);
      expect(voucher.createdAt).toBeDefined();
      expect(voucher.issuanceRatio).toBeCloseTo(0.01);
    });

    it('should respect provided status', () => {
      const input: VoucherInput = {
        token: 'cashuAbc...',
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 10000,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'issuer-123',
        mintUrl: 'https://mint.example.com',
        status: VoucherStatus.SPENT,
      };

      const voucher = createVoucher(input);
      expect(voucher.status).toBe(VoucherStatus.SPENT);
    });

    it('should generate unique IDs', () => {
      const input: VoucherInput = {
        token: 'cashuAbc...',
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 10000,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'issuer-123',
        mintUrl: 'https://mint.example.com',
      };

      const voucher1 = createVoucher(input);
      const voucher2 = createVoucher(input);

      expect(voucher1.id).not.toBe(voucher2.id);
    });
  });

  describe('isVoucherExpired', () => {
    it('should return false for voucher without expiry', () => {
      const voucher = createVoucher({
        token: 'cashuAbc...',
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 10000,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'issuer-123',
        mintUrl: 'https://mint.example.com',
      });

      expect(isVoucherExpired(voucher)).toBe(false);
    });

    it('should return true for expired voucher', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const voucher = createVoucher({
        token: 'cashuAbc...',
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 10000,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'issuer-123',
        mintUrl: 'https://mint.example.com',
        expiresAt: yesterday.toISOString(),
      });

      expect(isVoucherExpired(voucher)).toBe(true);
    });

    it('should return false for voucher expiring in future', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const voucher = createVoucher({
        token: 'cashuAbc...',
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 10000,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'issuer-123',
        mintUrl: 'https://mint.example.com',
        expiresAt: tomorrow.toISOString(),
      });

      expect(isVoucherExpired(voucher)).toBe(false);
    });

    it('should return false for voucher with EXPIRED status but no expiry date', () => {
      // Note: isVoucherExpired only checks the expiresAt date, not the status field
      const voucher = createVoucher({
        token: 'cashuAbc...',
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 10000,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'issuer-123',
        mintUrl: 'https://mint.example.com',
        status: VoucherStatus.EXPIRED,
      });

      // No expiresAt set, so isVoucherExpired returns false
      expect(isVoucherExpired(voucher)).toBe(false);
    });
  });

  describe('fromAutoRedemptionVoucher', () => {
    it('should convert auto-redemption voucher to canonical type', () => {
      const autoRedemptionVoucher = {
        voucher_id: 'auto-id-123',
        token: 'cashuAbc...',
        face_value: 100,
        face_unit: 'USD',
        face_decimals: 2,
        token_amount: 10000,
        token_unit: 'sat',
        backing_strategy: 'FULL' as const,
        issuer_id: 'merchant-pubkey-123',
        mint_url: 'https://mint.example.com',
        created_at: new Date().toISOString(),
        status: 'active' as const,
        merchant_metadata: {
          merchantId: 'merchant-pubkey-123',
          merchantName: 'Test Merchant',
        },
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };

      const voucher = fromAutoRedemptionVoucher(autoRedemptionVoucher);

      expect(voucher.faceValue).toBe(100);
      expect(voucher.faceUnit).toBe('USD');
      expect(voucher.tokenAmount).toBe(10000);
      expect(voucher.issuerId).toBe('merchant-pubkey-123');
      expect(voucher.issuerName).toBe('Test Merchant');
      expect(voucher.backingStrategy).toBe(BackingStrategy.FULL);
      expect(voucher.expiresAt).toBeDefined();
    });

    it('should detect MINIMAL backing strategy', () => {
      const autoRedemptionVoucher = {
        voucher_id: 'auto-id-123',
        token: 'cashuAbc...',
        face_value: 100,
        face_unit: 'USD',
        face_decimals: 2,
        token_amount: 10000,
        token_unit: 'sat',
        backing_strategy: 'MINIMAL' as const,
        issuer_id: 'merchant-pubkey-123',
        mint_url: 'https://mint.example.com',
        created_at: new Date().toISOString(),
        status: 'active' as const,
      };

      const voucher = fromAutoRedemptionVoucher(autoRedemptionVoucher);

      expect(voucher.backingStrategy).toBe(BackingStrategy.MINIMAL);
    });
  });

  describe('normalizeFilter', () => {
    it('should set default values', () => {
      const normalized = normalizeFilter({});

      expect(normalized.sortBy).toBe('createdAt');
      expect(normalized.sortOrder).toBe('desc');
      expect(normalized.limit).toBe(50); // Default is 50
      expect(normalized.offset).toBe(0);
      expect(normalized.includeExpired).toBe(false);
    });

    it('should preserve provided values', () => {
      const normalized = normalizeFilter({
        sortBy: 'faceValue',
        limit: 50,
        includeExpired: true,
      });

      expect(normalized.sortBy).toBe('faceValue');
      expect(normalized.limit).toBe(50);
      expect(normalized.includeExpired).toBe(true);
    });
  });

  describe('matchesFilter', () => {
    const createTestVoucher = (overrides: Partial<Voucher> = {}): Voucher => ({
      id: 'test-id',
      token: 'cashuAbc...',
      faceValue: 100,
      faceUnit: 'USD',
      faceDecimals: 2,
      tokenAmount: 10000,
      tokenUnit: 'sat',
      issuanceRatio: 0.01,
      backingStrategy: BackingStrategy.FULL,
      status: VoucherStatus.ACTIVE,
      issuerId: 'issuer-123',
      mintUrl: 'https://mint.example.com',
      createdAt: new Date().toISOString(),
      synced: false,
      ...overrides,
    });

    it('should match by status', () => {
      const voucher = createTestVoucher({ status: VoucherStatus.ACTIVE });
      const filter = normalizeFilter({ status: VoucherStatus.ACTIVE });

      expect(matchesFilter(voucher, filter)).toBe(true);
    });

    it('should not match wrong status', () => {
      const voucher = createTestVoucher({ status: VoucherStatus.ACTIVE });
      const filter = normalizeFilter({ status: VoucherStatus.SPENT });

      expect(matchesFilter(voucher, filter)).toBe(false);
    });

    it('should match by issuer', () => {
      const voucher = createTestVoucher({ issuerId: 'issuer-123' });
      const filter = normalizeFilter({ issuerId: 'issuer-123' });

      expect(matchesFilter(voucher, filter)).toBe(true);
    });

    it('should match by currency', () => {
      const voucher = createTestVoucher({ faceUnit: 'USD' });
      const filter = normalizeFilter({ faceUnit: 'USD' });

      expect(matchesFilter(voucher, filter)).toBe(true);
    });

    it('should match by value range', () => {
      const voucher = createTestVoucher({ faceValue: 100 });
      const filter = normalizeFilter({ minFaceValue: 50, maxFaceValue: 150 });

      expect(matchesFilter(voucher, filter)).toBe(true);
    });

    it('should filter out expired by default', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const voucher = createTestVoucher({ expiresAt: yesterday.toISOString() });
      const filter = normalizeFilter({});

      expect(matchesFilter(voucher, filter)).toBe(false);
    });

    it('should include expired when requested', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const voucher = createTestVoucher({ expiresAt: yesterday.toISOString() });
      const filter = normalizeFilter({ includeExpired: true });

      expect(matchesFilter(voucher, filter)).toBe(true);
    });

    it('should match by search text', () => {
      const voucher = createTestVoucher({ memo: 'Coffee voucher' });
      const filter = normalizeFilter({ searchText: 'coffee' });

      expect(matchesFilter(voucher, filter)).toBe(true);
    });
  });

  describe('sortVouchers', () => {
    const vouchers: Voucher[] = [
      {
        id: '1',
        token: 'cashu1...',
        faceValue: 100,
        faceUnit: 'USD',
        faceDecimals: 2,
        tokenAmount: 10000,
        tokenUnit: 'sat',
        issuanceRatio: 0.01,
        backingStrategy: BackingStrategy.FULL,
        status: VoucherStatus.ACTIVE,
        issuerId: 'issuer',
        mintUrl: 'https://mint.example.com',
        createdAt: '2024-01-01T00:00:00Z',
        synced: false,
      },
      {
        id: '2',
        token: 'cashu2...',
        faceValue: 200,
        faceUnit: 'USD',
        faceDecimals: 2,
        tokenAmount: 20000,
        tokenUnit: 'sat',
        issuanceRatio: 0.01,
        backingStrategy: BackingStrategy.FULL,
        status: VoucherStatus.ACTIVE,
        issuerId: 'issuer',
        mintUrl: 'https://mint.example.com',
        createdAt: '2024-01-02T00:00:00Z',
        synced: false,
      },
    ];

    it('should sort by createdAt desc', () => {
      const sorted = sortVouchers(vouchers, { field: 'createdAt', order: 'desc' });

      expect(sorted[0].id).toBe('2');
      expect(sorted[1].id).toBe('1');
    });

    it('should sort by createdAt asc', () => {
      const sorted = sortVouchers(vouchers, { field: 'createdAt', order: 'asc' });

      expect(sorted[0].id).toBe('1');
      expect(sorted[1].id).toBe('2');
    });

    it('should sort by faceValue', () => {
      const sorted = sortVouchers(vouchers, { field: 'faceValue', order: 'desc' });

      expect(sorted[0].faceValue).toBe(200);
    });
  });

  describe('paginateVouchers', () => {
    const vouchers: Voucher[] = Array.from({ length: 5 }, (_, i) => ({
      id: `${i}`,
      token: `cashu${i}...`,
      faceValue: 100 * (i + 1),
      faceUnit: 'USD',
      faceDecimals: 2,
      tokenAmount: 10000,
      tokenUnit: 'sat',
      issuanceRatio: 0.01,
      backingStrategy: BackingStrategy.FULL,
      status: VoucherStatus.ACTIVE,
      issuerId: 'issuer',
      mintUrl: 'https://mint.example.com',
      createdAt: new Date().toISOString(),
      synced: false,
    }));

    it('should paginate correctly', () => {
      const result = paginateVouchers(vouchers, 0, 2);

      expect(result.vouchers).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it('should handle offset', () => {
      const result = paginateVouchers(vouchers, 2, 2);

      expect(result.vouchers).toHaveLength(2);
      expect(result.vouchers[0].id).toBe('2');
    });

    it('should detect no more results', () => {
      const result = paginateVouchers(vouchers, 0, 10);

      expect(result.vouchers).toHaveLength(5);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('generateGroupKey', () => {
    const voucher: Voucher = {
      id: 'test-id',
      token: 'cashuAbc...',
      faceValue: 100,
      faceUnit: 'USD',
      faceDecimals: 2,
      tokenAmount: 10000,
      tokenUnit: 'sat',
      issuanceRatio: 0.01,
      backingStrategy: BackingStrategy.FULL,
      status: VoucherStatus.ACTIVE,
      issuerId: 'issuer-123',
      mintUrl: 'https://mint.example.com',
      createdAt: new Date().toISOString(),
      synced: false,
    };

    it('should generate key for single field', () => {
      const key = generateGroupKey(voucher, ['issuerId']);
      expect(key).toBe('issuer-123');
    });

    it('should generate key for multiple fields', () => {
      const key = generateGroupKey(voucher, ['issuerId', 'faceUnit']);
      expect(key).toBe('issuer-123-USD');
    });

    it('should handle unknown issuer', () => {
      const voucherNoIssuer = { ...voucher, issuerId: undefined };
      const key = generateGroupKey(voucherNoIssuer, ['issuerId']);
      expect(key).toBe('unknown');
    });
  });

  describe('canConsolidate', () => {
    const createConsolidateVoucher = (overrides: Partial<Voucher> = {}): Voucher => ({
      id: 'test-id',
      token: 'cashuAbc...',
      faceValue: 100,
      faceUnit: 'USD',
      faceDecimals: 2,
      tokenAmount: 10000,
      tokenUnit: 'sat',
      issuanceRatio: 0.01,
      backingStrategy: BackingStrategy.FULL,
      status: VoucherStatus.ACTIVE,
      issuerId: 'issuer-123',
      mintUrl: 'https://mint.example.com',
      createdAt: new Date().toISOString(),
      synced: false,
      ...overrides,
    });

    it('should allow consolidation of same issuer/currency', () => {
      const a = createConsolidateVoucher();
      const b = createConsolidateVoucher({ id: 'test-id-2' });

      expect(canConsolidate(a, b)).toBe(true);
    });

    it('should not allow consolidation of different issuers', () => {
      const a = createConsolidateVoucher({ issuerId: 'issuer-1' });
      const b = createConsolidateVoucher({ issuerId: 'issuer-2' });

      expect(canConsolidate(a, b)).toBe(false);
    });

    it('should not allow consolidation of different currencies', () => {
      const a = createConsolidateVoucher({ faceUnit: 'USD' });
      const b = createConsolidateVoucher({ faceUnit: 'EUR' });

      expect(canConsolidate(a, b)).toBe(false);
    });

    it('should not allow consolidation if not active', () => {
      const a = createConsolidateVoucher({ status: VoucherStatus.SPENT });
      const b = createConsolidateVoucher();

      expect(canConsolidate(a, b)).toBe(false);
    });

    it('should require same ratio for MINIMAL backing', () => {
      const a = createConsolidateVoucher({
        backingStrategy: BackingStrategy.MINIMAL,
        issuanceRatio: 0.5,
      });
      const b = createConsolidateVoucher({
        backingStrategy: BackingStrategy.MINIMAL,
        issuanceRatio: 0.6,
      });

      expect(canConsolidate(a, b)).toBe(false);
    });

    it('should require same expiry', () => {
      const a = createConsolidateVoucher({ expiresAt: '2024-12-31T00:00:00Z' });
      const b = createConsolidateVoucher({ expiresAt: '2025-01-31T00:00:00Z' });

      expect(canConsolidate(a, b)).toBe(false);
    });
  });
});
