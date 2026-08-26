/**
 * Adapter Tests
 *
 * Tests for adapter interfaces and VoucherServiceAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  VoucherServiceAdapter,
  isApiAdapter,
  isStorageAdapter,
  isNostrAdapter,
  type VoucherStoreInterface,
  type TransactionStoreInterface,
  type ServiceVoucher,
} from '../src/adapters';
import type { Voucher, TransactionInput } from '../src/types';

describe('Type Guards', () => {
  describe('isApiAdapter', () => {
    it('should return true for valid ApiAdapter', () => {
      const adapter = {
        splitPreview: vi.fn(),
        splitExecute: vi.fn(),
        sendTokenDm: vi.fn(),
        getProfile: vi.fn(),
      };
      expect(isApiAdapter(adapter)).toBe(true);
    });

    it('should return false for incomplete object', () => {
      expect(isApiAdapter({ splitPreview: vi.fn() })).toBe(false);
      expect(isApiAdapter(null)).toBe(false);
      expect(isApiAdapter(undefined)).toBe(false);
      expect(isApiAdapter('string')).toBe(false);
    });
  });

  describe('isStorageAdapter', () => {
    it('should return true for valid StorageAdapter', () => {
      const adapter = {
        getVouchers: vi.fn(),
        getVoucher: vi.fn(),
        saveVoucher: vi.fn(),
        removeVoucher: vi.fn(),
        updateVoucher: vi.fn(),
        addTransaction: vi.fn(),
      };
      expect(isStorageAdapter(adapter)).toBe(true);
    });

    it('should return false for incomplete object', () => {
      expect(isStorageAdapter({ getVouchers: vi.fn() })).toBe(false);
    });
  });

  describe('isNostrAdapter', () => {
    it('should return true for valid NostrAdapter', () => {
      const adapter = {
        queryRelayList: vi.fn(),
        fetchNip05: vi.fn(),
        publishProofs: vi.fn(),
      };
      expect(isNostrAdapter(adapter)).toBe(true);
    });

    it('should return false for incomplete object', () => {
      expect(isNostrAdapter({ queryRelayList: vi.fn() })).toBe(false);
    });
  });
});

describe('VoucherServiceAdapter', () => {
  let mockVoucherStore: VoucherStoreInterface;
  let mockTransactionStore: TransactionStoreInterface;
  let adapter: VoucherServiceAdapter;

  const mockServiceVoucher: ServiceVoucher = {
    id: 'voucher-123',
    token: 'cashuA...',
    faceValue: 5000,
    faceUnit: 'EUR',
    faceDecimals: 2,
    tokenAmount: 1000,
    tokenUnit: 'sat',
    backingStrategy: 'FULL',
    issuanceRatio: 5,
    issuerId: 'merchant-abc',
    issuerName: 'Test Merchant',
    status: 'active',
    expiresAt: '2026-12-31T23:59:59Z',
    createdAt: '2026-01-01T00:00:00Z',
    mintUrl: 'https://mint.example.com',
    memo: 'Test voucher',
  };

  beforeEach(() => {
    mockVoucherStore = {
      query: vi.fn().mockResolvedValue({ vouchers: [mockServiceVoucher] }),
      get: vi.fn().mockResolvedValue(mockServiceVoucher),
      add: vi.fn().mockResolvedValue(mockServiceVoucher),
      update: vi.fn().mockResolvedValue(mockServiceVoucher),
      delete: vi.fn().mockResolvedValue(true),
    };

    mockTransactionStore = {
      add: vi.fn().mockResolvedValue({ id: 'tx-123' }),
    };

    adapter = new VoucherServiceAdapter(mockVoucherStore, mockTransactionStore);
  });

  describe('getVouchers', () => {
    it('should return vouchers mapped to library format', async () => {
      const vouchers = await adapter.getVouchers();

      expect(vouchers).toHaveLength(1);
      expect(vouchers[0]).toMatchObject({
        voucher_id: 'voucher-123',
        token: 'cashuA...',
        face_value: 5000,
        face_unit: 'EUR',
        face_decimals: 2,
        token_amount: 1000,
        backing_strategy: 'FULL',
        issuer_id: 'merchant-abc',
        status: 'active',
      });
    });

    it('should pass filters to query', async () => {
      await adapter.getVouchers({ status: 'active', merchantId: 'merchant-abc' });

      expect(mockVoucherStore.query).toHaveBeenCalledWith({
        status: 'active',
        issuerId: 'merchant-abc',
      });
    });

    it('should apply minFaceValue filter locally', async () => {
      mockVoucherStore.query = vi.fn().mockResolvedValue({
        vouchers: [
          { ...mockServiceVoucher, faceValue: 1000 },
          { ...mockServiceVoucher, id: 'v2', faceValue: 5000 },
        ],
      });

      const vouchers = await adapter.getVouchers({ minFaceValue: 3000 });

      expect(vouchers).toHaveLength(1);
      expect(vouchers[0]!.face_value).toBe(5000);
    });

    it('should apply maxFaceValue filter locally', async () => {
      mockVoucherStore.query = vi.fn().mockResolvedValue({
        vouchers: [
          { ...mockServiceVoucher, faceValue: 1000 },
          { ...mockServiceVoucher, id: 'v2', faceValue: 5000 },
        ],
      });

      const vouchers = await adapter.getVouchers({ maxFaceValue: 3000 });

      expect(vouchers).toHaveLength(1);
      expect(vouchers[0]!.face_value).toBe(1000);
    });
  });

  describe('getVoucher', () => {
    it('should return voucher mapped to library format', async () => {
      const voucher = await adapter.getVoucher('voucher-123');

      expect(voucher).toMatchObject({
        voucher_id: 'voucher-123',
        face_value: 5000,
      });
      expect(mockVoucherStore.get).toHaveBeenCalledWith('voucher-123');
    });

    it('should return null for non-existent voucher', async () => {
      mockVoucherStore.get = vi.fn().mockResolvedValue(null);

      const voucher = await adapter.getVoucher('non-existent');

      expect(voucher).toBeNull();
    });
  });

  describe('saveVoucher', () => {
    const libraryVoucher: Voucher = {
      voucher_id: 'voucher-456',
      token: 'cashuB...',
      face_value: 3000,
      face_unit: 'USD',
      face_decimals: 2,
      token_amount: 500,
      backing_strategy: 'MINIMAL',
      status: 'active',
    };

    it('should add new voucher', async () => {
      mockVoucherStore.get = vi.fn().mockResolvedValue(null);

      await adapter.saveVoucher(libraryVoucher);

      expect(mockVoucherStore.add).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'voucher-456',
          token: 'cashuB...',
          faceValue: 3000,
          faceUnit: 'USD',
        })
      );
    });

    it('should update existing voucher', async () => {
      mockVoucherStore.get = vi.fn().mockResolvedValue(mockServiceVoucher);

      await adapter.saveVoucher({ ...libraryVoucher, voucher_id: 'voucher-123' });

      expect(mockVoucherStore.update).toHaveBeenCalledWith(
        'voucher-123',
        expect.objectContaining({
          faceValue: 3000,
        })
      );
    });
  });

  describe('removeVoucher', () => {
    it('should call delete on store', async () => {
      await adapter.removeVoucher('voucher-123');

      expect(mockVoucherStore.delete).toHaveBeenCalledWith('voucher-123');
    });
  });

  describe('updateVoucher', () => {
    it('should map and update voucher properties', async () => {
      await adapter.updateVoucher('voucher-123', {
        face_value: 4000,
        status: 'spent',
        memo: 'Updated',
      });

      expect(mockVoucherStore.update).toHaveBeenCalledWith('voucher-123', {
        faceValue: 4000,
        status: 'spent',
        memo: 'Updated',
      });
    });
  });

  describe('addTransaction', () => {
    const transaction: TransactionInput = {
      type: 'voucher_sent',
      direction: 'out',
      faceValue: 2500,
      faceUnit: 'EUR',
      faceDecimals: 2,
      voucherId: 'voucher-123',
      counterparty: 'recipient-pubkey',
      memo: 'Test payment',
    };

    it('should add transaction via store', async () => {
      await adapter.addTransaction(transaction);

      expect(mockTransactionStore.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'voucher_sent',
          direction: 'out',
          faceValue: 2500,
        })
      );
    });

    it('should warn when no transaction store configured', async () => {
      const adapterWithoutTxStore = new VoucherServiceAdapter(mockVoucherStore);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await adapterWithoutTxStore.addTransaction(transaction);

      expect(warnSpy).toHaveBeenCalledWith(
        '[VoucherServiceAdapter] No transaction store configured'
      );
      warnSpy.mockRestore();
    });
  });
});
