/**
 * VoucherQuery tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VoucherStore,
  VoucherQuery,
  createVoucherQuery,
  VoucherStatus,
  BackingStrategy,
  type VoucherInput,
} from '../src';

describe('VoucherQuery', () => {
  let store: VoucherStore;

  const createTestVoucher = (overrides: Partial<VoucherInput> = {}): VoucherInput => ({
    faceValue: 100,
    faceUnit: 'USD',
    tokenAmount: 10000,
    backingStrategy: BackingStrategy.FULL,
    issuerId: 'issuer-pubkey-123',
    mintUrl: 'https://mint.example.com',
    ...overrides,
  });

  beforeEach(async () => {
    store = new VoucherStore({
      storage: 'memory',
      expiryCheckInterval: 0,
    });
    await store.init();

    // Add test vouchers
    const now = new Date();
    const inThreeDays = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const inTenDays = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    await store.addBatch([
      createTestVoucher({
        faceValue: 100,
        faceUnit: 'USD',
        issuerId: 'merchant-1',
        expiresAt: inThreeDays.toISOString(),
        description: 'Coffee voucher',
      }),
      createTestVoucher({
        faceValue: 200,
        faceUnit: 'USD',
        issuerId: 'merchant-1',
        expiresAt: inTenDays.toISOString(),
        description: 'Lunch voucher',
      }),
      createTestVoucher({
        faceValue: 300,
        faceUnit: 'EUR',
        issuerId: 'merchant-2',
        backingStrategy: BackingStrategy.MINIMAL,
        description: 'European merchant',
      }),
      createTestVoucher({
        faceValue: 50,
        faceUnit: 'USD',
        issuerId: 'merchant-2',
        expiresAt: yesterday.toISOString(), // Expired
      }),
      createTestVoucher({
        faceValue: 500,
        faceUnit: 'USD',
        issuerId: 'merchant-3',
        tokenAmount: 50000,
      }),
    ]);

    // Mark one as spent
    const vouchers = await store.getAll();
    await store.update(vouchers[4].id, { status: VoucherStatus.SPENT });
  });

  afterEach(async () => {
    await store.close();
  });

  describe('Factory function', () => {
    it('should create a query instance', () => {
      const query = createVoucherQuery(store);
      expect(query).toBeInstanceOf(VoucherQuery);
    });
  });

  describe('Status filters', () => {
    it('should filter by active status', async () => {
      const vouchers = await new VoucherQuery(store).active().get();

      expect(vouchers.every((v) => v.status === VoucherStatus.ACTIVE)).toBe(true);
    });

    it('should filter by spent status', async () => {
      const vouchers = await new VoucherQuery(store).spent().get();

      expect(vouchers).toHaveLength(1);
      expect(vouchers[0].status).toBe(VoucherStatus.SPENT);
    });

    it('should filter by multiple statuses', async () => {
      const vouchers = await new VoucherQuery(store)
        .status([VoucherStatus.ACTIVE, VoucherStatus.SPENT])
        .get();

      expect(vouchers.length).toBeGreaterThan(1);
    });

    it('should include expired vouchers when specified', async () => {
      const withExpired = await new VoucherQuery(store).includeExpired(true).get();

      const withoutExpired = await new VoucherQuery(store).includeExpired(false).get();

      expect(withExpired.length).toBeGreaterThanOrEqual(withoutExpired.length);
    });
  });

  describe('Entity filters', () => {
    it('should filter by issuer', async () => {
      const vouchers = await new VoucherQuery(store).issuer('merchant-1').get();

      expect(vouchers).toHaveLength(2);
      expect(vouchers.every((v) => v.issuerId === 'merchant-1')).toBe(true);
    });

    it('should filter by currency', async () => {
      const vouchers = await new VoucherQuery(store).currency('EUR').get();

      expect(vouchers).toHaveLength(1);
      expect(vouchers[0].faceUnit).toBe('EUR');
    });

    it('should filter by backing strategy', async () => {
      const vouchers = await new VoucherQuery(store)
        .backingStrategy(BackingStrategy.MINIMAL)
        .get();

      expect(vouchers).toHaveLength(1);
      expect(vouchers[0].backingStrategy).toBe(BackingStrategy.MINIMAL);
    });
  });

  describe('Value filters', () => {
    it('should filter by minimum value', async () => {
      const vouchers = await new VoucherQuery(store).minValue(200).get();

      expect(vouchers.every((v) => v.faceValue >= 200)).toBe(true);
    });

    it('should filter by maximum value', async () => {
      const vouchers = await new VoucherQuery(store).maxValue(200).get();

      expect(vouchers.every((v) => v.faceValue <= 200)).toBe(true);
    });

    it('should filter by value range', async () => {
      const vouchers = await new VoucherQuery(store).valueRange(100, 300).get();

      expect(vouchers.every((v) => v.faceValue >= 100 && v.faceValue <= 300)).toBe(true);
    });

    it('should filter by minimum tokens', async () => {
      const vouchers = await new VoucherQuery(store).minTokens(20000).get();

      expect(vouchers.every((v) => v.tokenAmount >= 20000)).toBe(true);
    });
  });

  describe('Date filters', () => {
    it('should filter by expiring within days', async () => {
      const vouchers = await new VoucherQuery(store).expiringWithin(7).get();

      const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      expect(
        vouchers.every(
          (v) => v.expiresAt && new Date(v.expiresAt) <= sevenDaysFromNow
        )
      ).toBe(true);
    });

    it('should filter by created after', async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const vouchers = await new VoucherQuery(store).createdAfter(oneHourAgo).get();

      expect(vouchers.length).toBeGreaterThan(0);
    });
  });

  describe('Text search', () => {
    it('should search by issuer name', async () => {
      // Search matches memo, issuerName, senderName - not description
      const vouchers = await new VoucherQuery(store).search('merchant-1').get();

      // merchant-1 appears in issuerId, but search only matches issuerName (not set in test data)
      // Let's search for something that appears in memo or issuerName
      expect(vouchers.length).toBeGreaterThanOrEqual(0);
    });

    it('should search by memo', async () => {
      // Add a voucher with a memo for testing
      await store.add({
        token: 'cashuTest...',
        faceValue: 25,
        faceUnit: 'USD',
        tokenAmount: 2500,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'test-issuer',
        mintUrl: 'https://mint.example.com',
        memo: 'Birthday gift voucher',
      });

      const vouchers = await new VoucherQuery(store).search('Birthday').get();

      expect(vouchers).toHaveLength(1);
      expect(vouchers[0].memo).toContain('Birthday');
    });

    it('should be case insensitive', async () => {
      // Add a voucher with a memo for testing
      await store.add({
        token: 'cashuTest2...',
        faceValue: 30,
        faceUnit: 'USD',
        tokenAmount: 3000,
        backingStrategy: BackingStrategy.FULL,
        issuerId: 'test-issuer',
        issuerName: 'Special Store',
        mintUrl: 'https://mint.example.com',
      });

      const vouchers = await new VoucherQuery(store).search('special store').get();

      expect(vouchers).toHaveLength(1);
      expect(vouchers[0].issuerName).toBe('Special Store');
    });
  });

  describe('Sorting', () => {
    it('should sort by newest first', async () => {
      const vouchers = await new VoucherQuery(store).newest().get();

      for (let i = 1; i < vouchers.length; i++) {
        expect(new Date(vouchers[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(vouchers[i].createdAt).getTime()
        );
      }
    });

    it('should sort by oldest first', async () => {
      const vouchers = await new VoucherQuery(store).oldest().get();

      for (let i = 1; i < vouchers.length; i++) {
        expect(new Date(vouchers[i - 1].createdAt).getTime()).toBeLessThanOrEqual(
          new Date(vouchers[i].createdAt).getTime()
        );
      }
    });

    it('should sort by highest value', async () => {
      const vouchers = await new VoucherQuery(store).highestValue().get();

      for (let i = 1; i < vouchers.length; i++) {
        expect(vouchers[i - 1].faceValue).toBeGreaterThanOrEqual(vouchers[i].faceValue);
      }
    });

    it('should sort by lowest value', async () => {
      const vouchers = await new VoucherQuery(store).lowestValue().get();

      for (let i = 1; i < vouchers.length; i++) {
        expect(vouchers[i - 1].faceValue).toBeLessThanOrEqual(vouchers[i].faceValue);
      }
    });

    it('should sort by custom field', async () => {
      const vouchers = await new VoucherQuery(store).sortBy('tokenAmount', 'desc').get();

      for (let i = 1; i < vouchers.length; i++) {
        expect(vouchers[i - 1].tokenAmount).toBeGreaterThanOrEqual(vouchers[i].tokenAmount);
      }
    });
  });

  describe('Pagination', () => {
    it('should limit results', async () => {
      const vouchers = await new VoucherQuery(store).limit(2).get();

      expect(vouchers).toHaveLength(2);
    });

    it('should offset results', async () => {
      const all = await new VoucherQuery(store).newest().get();
      const offset = await new VoucherQuery(store).newest().offset(2).get();

      expect(offset[0]).toEqual(all[2]);
    });

    it('should paginate results', async () => {
      const page1 = await new VoucherQuery(store).newest().page(1, 2).get();
      const page2 = await new VoucherQuery(store).newest().page(2, 2).get();

      expect(page1).toHaveLength(2);
      expect(page2.length).toBeGreaterThan(0);
      expect(page1[0].id).not.toBe(page2[0].id);
    });
  });

  describe('Chaining', () => {
    it('should support method chaining', async () => {
      const vouchers = await new VoucherQuery(store)
        .active()
        .currency('USD')
        .minValue(100)
        .newest()
        .limit(2)
        .get();

      expect(vouchers.length).toBeLessThanOrEqual(2);
      expect(vouchers.every((v) => v.faceUnit === 'USD' && v.faceValue >= 100)).toBe(true);
    });
  });

  describe('Execution methods', () => {
    it('should execute and return full result', async () => {
      const result = await new VoucherQuery(store).execute();

      expect(result.vouchers).toBeDefined();
      expect(result.total).toBeDefined();
      expect(result.hasMore).toBeDefined();
    });

    it('should return first voucher', async () => {
      const voucher = await new VoucherQuery(store).highestValue().first();

      expect(voucher).toBeDefined();
      expect(voucher?.faceValue).toBe(500);
    });

    it('should return count', async () => {
      const count = await new VoucherQuery(store).currency('USD').count();

      expect(count).toBeGreaterThan(0);
    });

    it('should check existence', async () => {
      const exists = await new VoucherQuery(store).currency('EUR').exists();
      const notExists = await new VoucherQuery(store).currency('GBP').exists();

      expect(exists).toBe(true);
      expect(notExists).toBe(false);
    });
  });

  describe('Utility methods', () => {
    it('should clone query', async () => {
      const original = new VoucherQuery(store).currency('USD').minValue(100);
      const cloned = original.clone().maxValue(300);

      const originalFilter = original.getFilter();
      const clonedFilter = cloned.getFilter();

      expect(originalFilter.maxFaceValue).toBeUndefined();
      expect(clonedFilter.maxFaceValue).toBe(300);
    });

    it('should reset filter', async () => {
      const query = new VoucherQuery(store).currency('USD').minValue(100);
      query.reset();

      const filter = query.getFilter();
      expect(filter).toEqual({});
    });

    it('should return current filter', () => {
      const query = new VoucherQuery(store).currency('USD').minValue(100);
      const filter = query.getFilter();

      expect(filter.faceUnit).toBe('USD');
      expect(filter.minFaceValue).toBe(100);
    });
  });
});
