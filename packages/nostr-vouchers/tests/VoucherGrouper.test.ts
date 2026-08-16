/**
 * VoucherGrouper tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VoucherStore,
  VoucherGrouper,
  createVoucherGrouper,
  groupByIssuer,
  groupByCurrency,
  groupByBackingStrategy,
  getTopIssuers,
  BackingStrategy,
  type VoucherInput,
} from '../src';

describe('VoucherGrouper', () => {
  let store: VoucherStore;

  const createTestVoucher = (overrides: Partial<VoucherInput> = {}): VoucherInput => ({
    faceValue: 100,
    faceUnit: 'USD',
    tokenAmount: 10000,
    backingStrategy: BackingStrategy.FULL,
    issuerId: 'issuer-pubkey-123',
    issuerName: 'Test Merchant',
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
    const inSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await store.addBatch([
      // Merchant 1 - USD vouchers
      createTestVoucher({
        faceValue: 100,
        faceUnit: 'USD',
        tokenAmount: 10000,
        issuerId: 'merchant-1',
        issuerName: 'Coffee Shop',
        expiresAt: inSevenDays.toISOString(),
      }),
      createTestVoucher({
        faceValue: 200,
        faceUnit: 'USD',
        tokenAmount: 20000,
        issuerId: 'merchant-1',
        issuerName: 'Coffee Shop',
        expiresAt: inThirtyDays.toISOString(),
      }),
      // Merchant 1 - EUR vouchers
      createTestVoucher({
        faceValue: 150,
        faceUnit: 'EUR',
        tokenAmount: 15000,
        issuerId: 'merchant-1',
        issuerName: 'Coffee Shop',
      }),
      // Merchant 2 - MINIMAL backing
      createTestVoucher({
        faceValue: 300,
        faceUnit: 'USD',
        tokenAmount: 30000,
        issuerId: 'merchant-2',
        issuerName: 'Restaurant',
        backingStrategy: BackingStrategy.MINIMAL,
      }),
      // Merchant 3
      createTestVoucher({
        faceValue: 500,
        faceUnit: 'USD',
        tokenAmount: 50000,
        issuerId: 'merchant-3',
        issuerName: 'Hotel',
      }),
    ]);
  });

  afterEach(async () => {
    await store.close();
  });

  describe('Factory function', () => {
    it('should create a grouper instance', () => {
      const grouper = createVoucherGrouper(store);
      expect(grouper).toBeInstanceOf(VoucherGrouper);
    });
  });

  describe('Group by configuration', () => {
    it('should group by issuer', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      expect(result.groups).toHaveLength(3);
      expect(result.totalVouchers).toBe(5);

      const merchant1Group = result.groups.find((g) => g.issuerId === 'merchant-1');
      expect(merchant1Group?.count).toBe(3);
      expect(merchant1Group?.issuerName).toBe('Coffee Shop');
    });

    it('should group by currency', async () => {
      const result = await new VoucherGrouper(store).byCurrency().execute();

      expect(result.groups).toHaveLength(2);

      const usdGroup = result.groups.find((g) => g.faceUnit === 'USD');
      const eurGroup = result.groups.find((g) => g.faceUnit === 'EUR');

      expect(usdGroup?.count).toBe(4);
      expect(eurGroup?.count).toBe(1);
    });

    it('should group by backing strategy', async () => {
      const result = await new VoucherGrouper(store).byBackingStrategy().execute();

      expect(result.groups).toHaveLength(2);

      const fullGroup = result.groups.find((g) => g.backingStrategy === BackingStrategy.FULL);
      const minimalGroup = result.groups.find((g) => g.backingStrategy === BackingStrategy.MINIMAL);

      expect(fullGroup?.count).toBe(4);
      expect(minimalGroup?.count).toBe(1);
    });

    it('should group by multiple fields', async () => {
      const result = await new VoucherGrouper(store)
        .by('issuerId', 'faceUnit')
        .execute();

      // merchant-1/USD, merchant-1/EUR, merchant-2/USD, merchant-3/USD
      expect(result.groups).toHaveLength(4);
    });
  });

  describe('Pre-filters', () => {
    it('should filter active only', async () => {
      const result = await new VoucherGrouper(store).byIssuer().activeOnly().execute();

      expect(result.totalVouchers).toBe(5);
    });

    it('should filter by issuer', async () => {
      const result = await new VoucherGrouper(store)
        .byCurrency()
        .fromIssuer('merchant-1')
        .execute();

      expect(result.totalVouchers).toBe(3);
      expect(result.groups).toHaveLength(2); // USD and EUR
    });

    it('should filter by currency', async () => {
      const result = await new VoucherGrouper(store)
        .byIssuer()
        .withCurrency('USD')
        .execute();

      expect(result.totalVouchers).toBe(4);
    });

    it('should filter expiring within days', async () => {
      const result = await new VoucherGrouper(store)
        .byIssuer()
        .expiringWithin(14)
        .execute();

      // Only voucher expiring in 7 days should match
      expect(result.totalVouchers).toBe(1);
    });
  });

  describe('Aggregations', () => {
    it('should calculate total face value', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      const merchant1Group = result.groups.find((g) => g.issuerId === 'merchant-1');
      // 100 USD + 200 USD + 150 EUR = 450 total (mixed currencies)
      expect(merchant1Group?.totalFaceValue).toBe(450);
    });

    it('should calculate total token amount', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      const merchant1Group = result.groups.find((g) => g.issuerId === 'merchant-1');
      expect(merchant1Group?.totalTokenAmount).toBe(45000);
    });

    it('should calculate count', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      const merchant1Group = result.groups.find((g) => g.issuerId === 'merchant-1');
      expect(merchant1Group?.count).toBe(3);
    });

    it('should calculate min/max expiry', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      const merchant1Group = result.groups.find((g) => g.issuerId === 'merchant-1');
      expect(merchant1Group?.minExpiry).toBeDefined();
      expect(merchant1Group?.maxExpiry).toBeDefined();
      expect(new Date(merchant1Group!.minExpiry!).getTime()).toBeLessThan(
        new Date(merchant1Group!.maxExpiry!).getTime()
      );
    });

    it('should calculate averages when requested', async () => {
      const result = await new VoucherGrouper(store)
        .byIssuer()
        .withAllAggregations()
        .execute();

      const merchant1Group = result.groups.find((g) => g.issuerId === 'merchant-1');
      expect(merchant1Group?.avgFaceValue).toBe(150); // 450 / 3
      expect(merchant1Group?.avgTokenAmount).toBe(15000); // 45000 / 3
    });
  });

  describe('Sorting', () => {
    it('should sort by total face value', async () => {
      const result = await new VoucherGrouper(store).byIssuer().sortByValue().execute();

      for (let i = 1; i < result.groups.length; i++) {
        expect(result.groups[i - 1].totalFaceValue).toBeGreaterThanOrEqual(
          result.groups[i].totalFaceValue
        );
      }
    });

    it('should sort by count', async () => {
      const result = await new VoucherGrouper(store).byIssuer().sortByCount().execute();

      for (let i = 1; i < result.groups.length; i++) {
        expect(result.groups[i - 1].count).toBeGreaterThanOrEqual(result.groups[i].count);
      }
    });

    it('should sort by name', async () => {
      const result = await new VoucherGrouper(store).byIssuer().sortByName().execute();

      expect(result.groups[0].issuerName).toBe('Coffee Shop');
    });

    it('should sort by expiry', async () => {
      const result = await new VoucherGrouper(store).byIssuer().sortByExpiry().execute();

      // Groups with expiry should come first, sorted by minExpiry
      const withExpiry = result.groups.filter((g) => g.minExpiry);
      if (withExpiry.length > 1) {
        for (let i = 1; i < withExpiry.length; i++) {
          expect(new Date(withExpiry[i - 1].minExpiry!).getTime()).toBeLessThanOrEqual(
            new Date(withExpiry[i].minExpiry!).getTime()
          );
        }
      }
    });

    it('should support custom sort order', async () => {
      const result = await new VoucherGrouper(store)
        .byIssuer()
        .sortBy('totalFaceValue', 'asc')
        .execute();

      for (let i = 1; i < result.groups.length; i++) {
        expect(result.groups[i - 1].totalFaceValue).toBeLessThanOrEqual(
          result.groups[i].totalFaceValue
        );
      }
    });
  });

  describe('Limits', () => {
    it('should limit number of groups', async () => {
      const result = await new VoucherGrouper(store).byIssuer().limit(2).execute();

      expect(result.groups).toHaveLength(2);
    });

    it('should get top N by value', async () => {
      const result = await new VoucherGrouper(store).byIssuer().top(2).execute();

      expect(result.groups).toHaveLength(2);
      // Should be sorted by value descending
      expect(result.groups[0].totalFaceValue).toBeGreaterThanOrEqual(
        result.groups[1].totalFaceValue
      );
    });
  });

  describe('Include vouchers', () => {
    it('should include vouchers in results when requested', async () => {
      const result = await new VoucherGrouper(store)
        .byIssuer()
        .includeVouchers()
        .execute();

      for (const group of result.groups) {
        expect(group.vouchers).toBeDefined();
        expect(group.vouchers?.length).toBe(group.count);
      }
    });

    it('should not include vouchers by default', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      for (const group of result.groups) {
        expect(group.vouchers).toBeUndefined();
      }
    });
  });

  describe('Result totals', () => {
    it('should calculate total vouchers', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      expect(result.totalVouchers).toBe(5);
    });

    it('should calculate total face value by currency', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      expect(result.totalFaceValueByCurrency['USD']).toBe(1100); // 100+200+300+500
      expect(result.totalFaceValueByCurrency['EUR']).toBe(150);
    });

    it('should calculate total token amount', async () => {
      const result = await new VoucherGrouper(store).byIssuer().execute();

      expect(result.totalTokenAmount).toBe(125000);
    });
  });

  describe('Utility methods', () => {
    it('should clone grouper', async () => {
      const original = new VoucherGrouper(store).byIssuer().activeOnly();
      const cloned = original.clone().limit(1);

      const originalOptions = original.getOptions();
      const clonedOptions = cloned.getOptions();

      expect(originalOptions.limit).toBeUndefined();
      expect(clonedOptions.limit).toBe(1);
    });

    it('should reset options', async () => {
      const grouper = new VoucherGrouper(store).byIssuer().limit(1);
      grouper.reset();

      const options = grouper.getOptions();
      expect(options.limit).toBeUndefined();
      expect(options.groupBy).toBe('issuerId');
    });

    it('should get current options', () => {
      const grouper = new VoucherGrouper(store).byCurrency().limit(5);
      const options = grouper.getOptions();

      expect(options.groupBy).toBe('faceUnit');
      expect(options.limit).toBe(5);
    });
  });

  describe('Convenience functions', () => {
    it('should group by issuer with convenience function', async () => {
      const result = await groupByIssuer(store);

      expect(result.groups.length).toBeGreaterThan(0);
      expect(result.groups[0].issuerId).toBeDefined();
    });

    it('should group by currency with convenience function', async () => {
      const result = await groupByCurrency(store);

      expect(result.groups.length).toBeGreaterThan(0);
      expect(result.groups[0].faceUnit).toBeDefined();
    });

    it('should group by backing strategy with convenience function', async () => {
      const result = await groupByBackingStrategy(store);

      expect(result.groups.length).toBeGreaterThan(0);
      expect(result.groups[0].backingStrategy).toBeDefined();
    });

    it('should get top issuers with convenience function', async () => {
      const groups = await getTopIssuers(store, 2);

      expect(groups).toHaveLength(2);
      expect(groups[0].totalFaceValue).toBeGreaterThanOrEqual(groups[1].totalFaceValue);
    });
  });
});
