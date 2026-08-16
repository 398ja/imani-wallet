/**
 * Tests for filter functions
 */

import { describe, it, expect } from 'vitest';
import {
  TransactionType,
  TransactionDirection,
  matchesFilter,
  sortTransactions,
  paginateTransactions,
  normalizeFilter,
  DEFAULT_FILTER,
  type Transaction,
} from '../../src';

describe('Filter Functions', () => {
  describe('normalizeFilter()', () => {
    it('should apply default values', () => {
      const normalized = normalizeFilter({});

      expect(normalized.limit).toBe(DEFAULT_FILTER.limit);
      expect(normalized.offset).toBe(DEFAULT_FILTER.offset);
      expect(normalized.sortBy).toBe(DEFAULT_FILTER.sortBy);
      expect(normalized.sortOrder).toBe(DEFAULT_FILTER.sortOrder);
    });

    it('should preserve custom values', () => {
      const normalized = normalizeFilter({
        limit: 100,
        offset: 50,
        sortBy: 'amount',
        sortOrder: 'asc',
      });

      expect(normalized.limit).toBe(100);
      expect(normalized.offset).toBe(50);
      expect(normalized.sortBy).toBe('amount');
      expect(normalized.sortOrder).toBe('asc');
    });
  });

  describe('matchesFilter()', () => {
    const baseTx: Transaction = createTestTransaction();

    describe('type filter', () => {
      it('should match single type', () => {
        expect(
          matchesFilter(baseTx, { type: TransactionType.RECEIVED })
        ).toBe(true);
        expect(
          matchesFilter(baseTx, { type: TransactionType.SENT })
        ).toBe(false);
      });

      it('should match multiple types', () => {
        expect(
          matchesFilter(baseTx, {
            type: [TransactionType.RECEIVED, TransactionType.SENT],
          })
        ).toBe(true);
      });
    });

    describe('direction filter', () => {
      it('should match single direction', () => {
        expect(
          matchesFilter(baseTx, { direction: TransactionDirection.IN })
        ).toBe(true);
        expect(
          matchesFilter(baseTx, { direction: TransactionDirection.OUT })
        ).toBe(false);
      });

      it('should match multiple directions', () => {
        expect(
          matchesFilter(baseTx, {
            direction: [TransactionDirection.IN, TransactionDirection.OUT],
          })
        ).toBe(true);
      });
    });

    describe('party filters', () => {
      it('should filter by counterparty', () => {
        expect(matchesFilter(baseTx, { counterparty: 'alice-pubkey' })).toBe(true);
        expect(matchesFilter(baseTx, { counterparty: 'bob-pubkey' })).toBe(false);
      });

      it('should filter by issuer', () => {
        expect(matchesFilter(baseTx, { issuerId: 'merchant-pubkey' })).toBe(true);
        expect(matchesFilter(baseTx, { issuerId: 'other-merchant' })).toBe(false);
      });

      it('should filter by wallet', () => {
        expect(matchesFilter(baseTx, { walletId: 'wallet-123' })).toBe(true);
        expect(matchesFilter(baseTx, { walletId: 'wallet-456' })).toBe(false);
      });
    });

    describe('time filter', () => {
      it('should filter by fromTimestamp', () => {
        expect(matchesFilter(baseTx, { fromTimestamp: 1704000000 })).toBe(true);
        expect(matchesFilter(baseTx, { fromTimestamp: 1705000000 })).toBe(false);
      });

      it('should filter by toTimestamp', () => {
        expect(matchesFilter(baseTx, { toTimestamp: 1705000000 })).toBe(true);
        expect(matchesFilter(baseTx, { toTimestamp: 1704000000 })).toBe(false);
      });

      it('should filter by time range', () => {
        expect(
          matchesFilter(baseTx, {
            fromTimestamp: 1704000000,
            toTimestamp: 1705000000,
          })
        ).toBe(true);
        expect(
          matchesFilter(baseTx, {
            fromTimestamp: 1705000000,
            toTimestamp: 1706000000,
          })
        ).toBe(false);
      });
    });

    describe('amount filter', () => {
      it('should filter by minAmount', () => {
        expect(matchesFilter(baseTx, { minAmount: 4000 })).toBe(true);
        expect(matchesFilter(baseTx, { minAmount: 6000 })).toBe(false);
      });

      it('should filter by maxAmount', () => {
        expect(matchesFilter(baseTx, { maxAmount: 6000 })).toBe(true);
        expect(matchesFilter(baseTx, { maxAmount: 4000 })).toBe(false);
      });

      it('should filter by amount range', () => {
        expect(
          matchesFilter(baseTx, { minAmount: 4000, maxAmount: 6000 })
        ).toBe(true);
        expect(
          matchesFilter(baseTx, { minAmount: 6000, maxAmount: 8000 })
        ).toBe(false);
      });
    });

    describe('unit filter', () => {
      it('should filter by currency unit', () => {
        expect(matchesFilter(baseTx, { unit: 'USD' })).toBe(true);
        expect(matchesFilter(baseTx, { unit: 'EUR' })).toBe(false);
      });
    });

    describe('sync filter', () => {
      it('should filter by synced status', () => {
        expect(matchesFilter(baseTx, { synced: false })).toBe(true);
        expect(matchesFilter(baseTx, { synced: true })).toBe(false);
      });
    });

    describe('text search', () => {
      it('should search in memo', () => {
        expect(matchesFilter(baseTx, { searchText: 'coffee' })).toBe(true);
        expect(matchesFilter(baseTx, { searchText: 'pizza' })).toBe(false);
      });

      it('should search in issuerName', () => {
        expect(matchesFilter(baseTx, { searchText: 'Coffee Shop' })).toBe(true);
      });

      it('should search in counterpartyName', () => {
        expect(matchesFilter(baseTx, { searchText: 'Alice' })).toBe(true);
      });

      it('should be case insensitive', () => {
        expect(matchesFilter(baseTx, { searchText: 'COFFEE' })).toBe(true);
        expect(matchesFilter(baseTx, { searchText: 'alice' })).toBe(true);
      });
    });

    describe('combined filters', () => {
      it('should match all conditions', () => {
        expect(
          matchesFilter(baseTx, {
            type: TransactionType.RECEIVED,
            direction: TransactionDirection.IN,
            counterparty: 'alice-pubkey',
            unit: 'USD',
          })
        ).toBe(true);
      });

      it('should fail if any condition fails', () => {
        expect(
          matchesFilter(baseTx, {
            type: TransactionType.RECEIVED,
            direction: TransactionDirection.OUT, // Wrong direction
          })
        ).toBe(false);
      });
    });
  });

  describe('sortTransactions()', () => {
    const transactions = [
      createTestTransaction({ timestamp: 1704067200, tokenAmount: 1000, faceValue: 5000 }),
      createTestTransaction({ timestamp: 1704070800, tokenAmount: 2000, faceValue: 3000 }),
      createTestTransaction({ timestamp: 1704064600, tokenAmount: 500, faceValue: 8000 }),
    ];

    it('should sort by timestamp descending', () => {
      const sorted = sortTransactions(transactions, 'timestamp', 'desc');
      expect(sorted[0].timestamp).toBe(1704070800);
      expect(sorted[2].timestamp).toBe(1704064600);
    });

    it('should sort by timestamp ascending', () => {
      const sorted = sortTransactions(transactions, 'timestamp', 'asc');
      expect(sorted[0].timestamp).toBe(1704064600);
      expect(sorted[2].timestamp).toBe(1704070800);
    });

    it('should sort by amount descending', () => {
      const sorted = sortTransactions(transactions, 'amount', 'desc');
      expect(sorted[0].tokenAmount).toBe(2000);
      expect(sorted[2].tokenAmount).toBe(500);
    });

    it('should sort by faceValue', () => {
      const sorted = sortTransactions(transactions, 'faceValue', 'desc');
      expect(sorted[0].faceValue).toBe(8000);
      expect(sorted[2].faceValue).toBe(3000);
    });

    it('should not mutate original array', () => {
      const original = [...transactions];
      sortTransactions(transactions, 'timestamp', 'desc');
      expect(transactions).toEqual(original);
    });
  });

  describe('paginateTransactions()', () => {
    const transactions = Array.from({ length: 10 }, (_, i) =>
      createTestTransaction({ faceValue: (i + 1) * 100 })
    );

    it('should return first page', () => {
      const result = paginateTransactions(transactions, 0, 3);
      expect(result.transactions).toHaveLength(3);
      expect(result.hasMore).toBe(true);
    });

    it('should return middle page', () => {
      const result = paginateTransactions(transactions, 3, 3);
      expect(result.transactions).toHaveLength(3);
      expect(result.hasMore).toBe(true);
    });

    it('should return last page', () => {
      const result = paginateTransactions(transactions, 9, 3);
      expect(result.transactions).toHaveLength(1);
      expect(result.hasMore).toBe(false);
    });

    it('should handle exact fit', () => {
      const result = paginateTransactions(transactions, 0, 10);
      expect(result.transactions).toHaveLength(10);
      expect(result.hasMore).toBe(false);
    });

    it('should handle offset beyond length', () => {
      const result = paginateTransactions(transactions, 15, 3);
      expect(result.transactions).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });
  });
});

// Helper function
function createTestTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `tx-${Math.random().toString(36).substring(7)}`,
    type: TransactionType.RECEIVED,
    direction: TransactionDirection.IN,
    tokenAmount: 1000,
    faceValue: 5000,
    faceUnit: 'USD',
    faceDecimals: 2,
    counterparty: 'alice-pubkey',
    counterpartyName: 'Alice',
    issuerId: 'merchant-pubkey',
    issuerName: 'Coffee Shop',
    walletId: 'wallet-123',
    memo: 'Payment for coffee',
    timestamp: 1704067200,
    synced: false,
    ...overrides,
  };
}
