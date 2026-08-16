/**
 * Tests for TransactionQuery
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TransactionStore,
  TransactionQuery,
  createQuery,
  TransactionType,
  TransactionDirection,
  type TransactionInput,
} from '../../src';

describe('TransactionQuery', () => {
  let store: TransactionStore;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(async () => {
    store = new TransactionStore({ storage: 'memory' });
    await store.init();

    // Create test data
    await store.recordBatch([
      createTestInput({
        type: TransactionType.RECEIVED,
        direction: TransactionDirection.IN,
        faceValue: 1000,
        faceUnit: 'USD',
        counterparty: 'alice',
        timestamp: now - 86400, // 1 day ago
        memo: 'Payment for coffee',
      }),
      createTestInput({
        type: TransactionType.SENT,
        direction: TransactionDirection.OUT,
        faceValue: 2000,
        faceUnit: 'USD',
        counterparty: 'bob',
        timestamp: now - 43200, // 12 hours ago
        memo: 'Rent payment',
      }),
      createTestInput({
        type: TransactionType.RECEIVED,
        direction: TransactionDirection.IN,
        faceValue: 5000,
        faceUnit: 'EUR',
        counterparty: 'alice',
        issuerId: 'merchant-1',
        timestamp: now - 3600, // 1 hour ago
        memo: 'Salary',
      }),
      createTestInput({
        type: TransactionType.PURCHASED,
        direction: TransactionDirection.IN,
        faceValue: 500,
        faceUnit: 'USD',
        issuerId: 'merchant-2',
        timestamp: now, // now
        memo: 'Gift card purchase',
      }),
    ]);
  });

  afterEach(async () => {
    await store.close();
  });

  describe('basic query building', () => {
    it('should create query from store.find()', () => {
      const query = store.find();
      expect(query).toBeInstanceOf(TransactionQuery);
    });

    it('should create query with createQuery()', () => {
      const query = createQuery(store);
      expect(query).toBeInstanceOf(TransactionQuery);
    });

    it('should return all transactions without filters', async () => {
      const results = await store.find().execute();
      expect(results.transactions).toHaveLength(4);
    });
  });

  describe('type filters', () => {
    it('should filter by single type', async () => {
      const results = await store.find().type(TransactionType.RECEIVED).get();
      expect(results).toHaveLength(2);
    });

    it('should filter by multiple types', async () => {
      const results = await store
        .find()
        .type([TransactionType.RECEIVED, TransactionType.SENT])
        .get();
      expect(results).toHaveLength(3);
    });

    it('should use received() shorthand', async () => {
      const results = await store.find().received().get();
      expect(results).toHaveLength(2);
    });

    it('should use sent() shorthand', async () => {
      const results = await store.find().sent().get();
      expect(results).toHaveLength(1);
    });

    it('should use purchased() shorthand', async () => {
      const results = await store.find().purchased().get();
      expect(results).toHaveLength(1);
    });
  });

  describe('direction filters', () => {
    it('should filter by direction', async () => {
      const results = await store
        .find()
        .direction(TransactionDirection.IN)
        .get();
      expect(results).toHaveLength(3);
    });

    it('should use incoming() shorthand', async () => {
      const results = await store.find().incoming().get();
      expect(results).toHaveLength(3);
    });

    it('should use outgoing() shorthand', async () => {
      const results = await store.find().outgoing().get();
      expect(results).toHaveLength(1);
    });
  });

  describe('party filters', () => {
    it('should filter by counterparty', async () => {
      const results = await store.find().counterparty('alice').get();
      expect(results).toHaveLength(2);
    });

    it('should filter by issuer', async () => {
      const results = await store.find().issuer('merchant-1').get();
      expect(results).toHaveLength(1);
    });
  });

  describe('date filters', () => {
    it('should filter by fromDate with string', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dateStr = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD
      const results = await store.find().fromDate(dateStr).get();
      expect(results.length).toBeGreaterThan(0);
    });

    it('should filter by fromDate with Date object', async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const results = await store.find().fromDate(yesterday).get();
      expect(results.length).toBeGreaterThan(0);
    });

    it('should filter by fromDate with timestamp', async () => {
      const results = await store.find().fromDate(now - 7200).get(); // 2 hours ago
      expect(results).toHaveLength(2);
    });

    it('should filter by toDate', async () => {
      const results = await store.find().toDate(now - 3600).get(); // 1 hour ago
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by between', async () => {
      const results = await store
        .find()
        .between(now - 50000, now - 40000)
        .get();
      expect(results).toHaveLength(1); // Only the 12-hour-ago transaction
    });

    it('should filter by lastDays', async () => {
      const results = await store.find().lastDays(2).get();
      expect(results).toHaveLength(4);
    });
  });

  describe('amount filters', () => {
    it('should filter by minAmount', async () => {
      const results = await store.find().minAmount(1500).get();
      expect(results).toHaveLength(2);
    });

    it('should filter by maxAmount', async () => {
      const results = await store.find().maxAmount(1500).get();
      expect(results).toHaveLength(2);
    });

    it('should filter by amountBetween', async () => {
      const results = await store.find().amountBetween(1000, 3000).get();
      expect(results).toHaveLength(2);
    });
  });

  describe('other filters', () => {
    it('should filter by unit', async () => {
      const results = await store.find().unit('EUR').get();
      expect(results).toHaveLength(1);
    });

    it('should search by text', async () => {
      const results = await store.find().search('coffee').get();
      expect(results).toHaveLength(1);
    });

    it('should search case-insensitively', async () => {
      const results = await store.find().search('SALARY').get();
      expect(results).toHaveLength(1);
    });
  });

  describe('pagination', () => {
    it('should limit results', async () => {
      const results = await store.find().limit(2).execute();
      expect(results.transactions).toHaveLength(2);
      expect(results.hasMore).toBe(true);
    });

    it('should offset results', async () => {
      const results = await store.find().offset(2).limit(10).execute();
      expect(results.transactions).toHaveLength(2);
      expect(results.offset).toBe(2);
    });

    it('should use skip/take aliases', async () => {
      const results = await store.find().skip(1).take(2).execute();
      expect(results.transactions).toHaveLength(2);
      expect(results.offset).toBe(1);
    });

    it('should handle page()', async () => {
      const page1 = await store.find().page(1, 2).execute();
      const page2 = await store.find().page(2, 2).execute();

      expect(page1.transactions).toHaveLength(2);
      expect(page2.transactions).toHaveLength(2);
      expect(page1.transactions[0].id).not.toBe(page2.transactions[0].id);
    });
  });

  describe('sorting', () => {
    it('should sort by timestamp descending', async () => {
      const results = await store.find().sortBy('timestamp', 'desc').get();
      expect(results[0].faceValue).toBe(500); // Most recent
    });

    it('should sort by timestamp ascending', async () => {
      const results = await store.find().sortBy('timestamp', 'asc').get();
      expect(results[0].faceValue).toBe(1000); // Oldest
    });

    it('should use newest() shorthand', async () => {
      const results = await store.find().newest().get();
      expect(results[0].faceValue).toBe(500);
    });

    it('should use oldest() shorthand', async () => {
      const results = await store.find().oldest().get();
      expect(results[0].faceValue).toBe(1000);
    });

    it('should use largest() shorthand', async () => {
      const results = await store.find().largest().get();
      expect(results[0].faceValue).toBe(5000);
    });

    it('should use smallest() shorthand', async () => {
      const results = await store.find().smallest().get();
      expect(results[0].faceValue).toBe(500);
    });
  });

  describe('result methods', () => {
    it('should get first result', async () => {
      const result = await store.find().received().newest().first();
      expect(result).not.toBeNull();
      expect(result?.type).toBe(TransactionType.RECEIVED);
    });

    it('should return null for empty first()', async () => {
      const result = await store
        .find()
        .type(TransactionType.EXPIRED)
        .first();
      expect(result).toBeNull();
    });

    it('should count results', async () => {
      const count = await store.find().received().count();
      expect(count).toBe(2);
    });

    it('should check exists()', async () => {
      const exists = await store.find().received().exists();
      expect(exists).toBe(true);

      const notExists = await store.find().type(TransactionType.EXPIRED).exists();
      expect(notExists).toBe(false);
    });

    it('should get stats', async () => {
      const stats = await store.find().incoming().stats();
      expect(stats.totalIn).toBeGreaterThan(0);
      expect(stats.countIn).toBe(3);
    });
  });

  describe('chaining', () => {
    it('should chain multiple filters', async () => {
      const results = await store
        .find()
        .received()
        .counterparty('alice')
        .minAmount(500)
        .newest()
        .limit(10)
        .get();

      expect(results).toHaveLength(2);
    });

    it('should return correct filter with getFilter()', () => {
      const query = store
        .find()
        .type(TransactionType.RECEIVED)
        .counterparty('alice')
        .limit(10);

      const filter = query.getFilter();
      expect(filter.type).toBe(TransactionType.RECEIVED);
      expect(filter.counterparty).toBe('alice');
      expect(filter.limit).toBe(10);
    });

    it('should reset filter', () => {
      const query = store
        .find()
        .type(TransactionType.RECEIVED)
        .limit(10);

      query.reset();
      const filter = query.getFilter();
      expect(filter.type).toBeUndefined();
      expect(filter.limit).toBeUndefined();
    });

    it('should clone query', async () => {
      const original = store.find().received().limit(10);
      const cloned = original.clone();

      // Modify original
      original.sent();

      // Cloned should still be received
      const filter = cloned.getFilter();
      expect(filter.type).toBe(TransactionType.RECEIVED);
    });
  });

  describe('from() disambiguation', () => {
    it('should treat date-like string as fromDate', async () => {
      const query = store.find().from('2024-01-01');
      const filter = query.getFilter();
      expect(filter.fromTimestamp).toBeDefined();
      expect(filter.counterparty).toBeUndefined();
    });

    it('should treat non-date string as counterparty', async () => {
      const query = store.find().from('alice-pubkey');
      const filter = query.getFilter();
      expect(filter.counterparty).toBe('alice-pubkey');
      expect(filter.fromTimestamp).toBeUndefined();
    });
  });
});

// Helper function
function createTestInput(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    type: TransactionType.RECEIVED,
    direction: TransactionDirection.IN,
    tokenAmount: 1000,
    faceValue: 5000,
    faceUnit: 'USD',
    faceDecimals: 2,
    ...overrides,
  };
}
