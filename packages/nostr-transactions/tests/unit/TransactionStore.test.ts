/**
 * Tests for TransactionStore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TransactionStore,
  TransactionType,
  TransactionDirection,
  type TransactionInput,
} from '../../src';

describe('TransactionStore', () => {
  let store: TransactionStore;

  beforeEach(async () => {
    // Use memory adapter for fast tests
    store = new TransactionStore({ storage: 'memory' });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('initialization', () => {
    it('should initialize successfully', () => {
      expect(store.isInitialized()).toBe(true);
    });

    it('should allow multiple init calls without error', async () => {
      await store.init();
      await store.init();
      expect(store.isInitialized()).toBe(true);
    });

    it('should throw when not initialized', async () => {
      const newStore = new TransactionStore({ storage: 'memory' });
      await expect(newStore.record(createTestInput())).rejects.toThrow('not initialized');
    });
  });

  describe('record()', () => {
    it('should record a new transaction', async () => {
      const input = createTestInput();
      const tx = await store.record(input);

      expect(tx.id).toBeDefined();
      expect(tx.type).toBe(input.type);
      expect(tx.direction).toBe(input.direction);
      expect(tx.tokenAmount).toBe(input.tokenAmount);
      expect(tx.faceValue).toBe(input.faceValue);
      expect(tx.faceUnit).toBe(input.faceUnit);
      expect(tx.synced).toBe(false);
    });

    it('should generate unique IDs', async () => {
      const tx1 = await store.record(createTestInput());
      const tx2 = await store.record(createTestInput());

      expect(tx1.id).not.toBe(tx2.id);
    });

    it('should set timestamp to current time if not provided', async () => {
      const now = Math.floor(Date.now() / 1000);
      const tx = await store.record(createTestInput());

      expect(tx.timestamp).toBeGreaterThanOrEqual(now - 1);
      expect(tx.timestamp).toBeLessThanOrEqual(now + 1);
    });

    it('should use provided timestamp', async () => {
      const timestamp = 1704067200; // 2024-01-01
      const tx = await store.record({ ...createTestInput(), timestamp });

      expect(tx.timestamp).toBe(timestamp);
    });
  });

  describe('recordBatch()', () => {
    it('should record multiple transactions', async () => {
      const inputs = [
        createTestInput({ faceValue: 1000 }),
        createTestInput({ faceValue: 2000 }),
        createTestInput({ faceValue: 3000 }),
      ];

      const transactions = await store.recordBatch(inputs);

      expect(transactions).toHaveLength(3);
      expect(transactions[0].faceValue).toBe(1000);
      expect(transactions[1].faceValue).toBe(2000);
      expect(transactions[2].faceValue).toBe(3000);
    });

    it('should generate unique IDs for each transaction', async () => {
      const inputs = [createTestInput(), createTestInput(), createTestInput()];
      const transactions = await store.recordBatch(inputs);

      const ids = transactions.map((tx) => tx.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('get()', () => {
    it('should retrieve a transaction by ID', async () => {
      const input = createTestInput({ memo: 'test memo' });
      const created = await store.record(input);

      const retrieved = await store.get(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.memo).toBe('test memo');
    });

    it('should return null for non-existent ID', async () => {
      const result = await store.get('non-existent-id');
      expect(result).toBeNull();
    });
  });

  describe('getByEventId()', () => {
    it('should retrieve a transaction by event ID', async () => {
      const tx = await store.record(createTestInput());
      await store.update(tx.id, { eventId: 'event123' });

      const retrieved = await store.getByEventId('event123');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(tx.id);
    });

    it('should return null for non-existent event ID', async () => {
      const result = await store.getByEventId('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('update()', () => {
    it('should update a transaction', async () => {
      const tx = await store.record(createTestInput());

      const updated = await store.update(tx.id, {
        memo: 'updated memo',
        counterpartyName: 'Alice',
      });

      expect(updated.memo).toBe('updated memo');
      expect(updated.counterpartyName).toBe('Alice');
      // Original fields should be preserved
      expect(updated.faceValue).toBe(tx.faceValue);
    });

    it('should throw for non-existent transaction', async () => {
      await expect(store.update('non-existent', { memo: 'test' })).rejects.toThrow(
        'not found'
      );
    });

    it('should update sync status', async () => {
      const tx = await store.record(createTestInput());
      expect(tx.synced).toBe(false);

      const updated = await store.update(tx.id, {
        synced: true,
        syncedAt: 1704067200,
        eventId: 'event456',
      });

      expect(updated.synced).toBe(true);
      expect(updated.syncedAt).toBe(1704067200);
      expect(updated.eventId).toBe('event456');
    });
  });

  describe('delete()', () => {
    it('should delete a transaction', async () => {
      const tx = await store.record(createTestInput());

      const result = await store.delete(tx.id);

      expect(result).toBe(true);
      expect(await store.get(tx.id)).toBeNull();
    });

    it('should return false for non-existent ID', async () => {
      const result = await store.delete('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('deleteBatch()', () => {
    it('should delete multiple transactions', async () => {
      const tx1 = await store.record(createTestInput());
      const tx2 = await store.record(createTestInput());
      const tx3 = await store.record(createTestInput());

      const deleted = await store.deleteBatch([tx1.id, tx2.id]);

      expect(deleted).toBe(2);
      expect(await store.get(tx1.id)).toBeNull();
      expect(await store.get(tx2.id)).toBeNull();
      expect(await store.get(tx3.id)).not.toBeNull();
    });
  });

  describe('query()', () => {
    beforeEach(async () => {
      // Create test data
      const now = Math.floor(Date.now() / 1000);
      await store.recordBatch([
        createTestInput({
          type: TransactionType.RECEIVED,
          direction: TransactionDirection.IN,
          faceValue: 1000,
          timestamp: now - 3600,
          counterparty: 'alice',
        }),
        createTestInput({
          type: TransactionType.SENT,
          direction: TransactionDirection.OUT,
          faceValue: 2000,
          timestamp: now - 1800,
          counterparty: 'bob',
        }),
        createTestInput({
          type: TransactionType.RECEIVED,
          direction: TransactionDirection.IN,
          faceValue: 3000,
          timestamp: now,
          counterparty: 'alice',
        }),
      ]);
    });

    it('should return all transactions without filter', async () => {
      const result = await store.query({});
      expect(result.transactions).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it('should filter by type', async () => {
      const result = await store.query({ type: TransactionType.RECEIVED });
      expect(result.transactions).toHaveLength(2);
    });

    it('should filter by direction', async () => {
      const result = await store.query({ direction: TransactionDirection.OUT });
      expect(result.transactions).toHaveLength(1);
    });

    it('should filter by counterparty', async () => {
      const result = await store.query({ counterparty: 'alice' });
      expect(result.transactions).toHaveLength(2);
    });

    it('should apply limit', async () => {
      const result = await store.query({ limit: 2 });
      expect(result.transactions).toHaveLength(2);
      expect(result.hasMore).toBe(true);
    });

    it('should apply offset', async () => {
      const result = await store.query({ offset: 1, limit: 10 });
      expect(result.transactions).toHaveLength(2);
      expect(result.offset).toBe(1);
    });

    it('should sort by timestamp descending by default', async () => {
      const result = await store.query({});
      expect(result.transactions[0].faceValue).toBe(3000); // Most recent
      expect(result.transactions[2].faceValue).toBe(1000); // Oldest
    });

    it('should sort ascending when specified', async () => {
      const result = await store.query({ sortOrder: 'asc' });
      expect(result.transactions[0].faceValue).toBe(1000); // Oldest
      expect(result.transactions[2].faceValue).toBe(3000); // Most recent
    });
  });

  describe('getRecent()', () => {
    it('should return recent transactions', async () => {
      await store.recordBatch([
        createTestInput({ faceValue: 100 }),
        createTestInput({ faceValue: 200 }),
        createTestInput({ faceValue: 300 }),
      ]);

      const recent = await store.getRecent(2);
      expect(recent).toHaveLength(2);
    });
  });

  describe('getByType()', () => {
    it('should return transactions of specific type', async () => {
      await store.record(createTestInput({ type: TransactionType.RECEIVED }));
      await store.record(createTestInput({ type: TransactionType.SENT }));
      await store.record(createTestInput({ type: TransactionType.RECEIVED }));

      const received = await store.getByType(TransactionType.RECEIVED);
      expect(received).toHaveLength(2);
    });

    it('should return transactions of multiple types', async () => {
      await store.record(createTestInput({ type: TransactionType.RECEIVED }));
      await store.record(createTestInput({ type: TransactionType.SENT }));
      await store.record(createTestInput({ type: TransactionType.PURCHASED }));

      const results = await store.getByType([TransactionType.RECEIVED, TransactionType.SENT]);
      expect(results).toHaveLength(2);
    });
  });

  describe('count()', () => {
    it('should count all transactions', async () => {
      await store.recordBatch([createTestInput(), createTestInput(), createTestInput()]);
      expect(await store.count()).toBe(3);
    });

    it('should count with filter', async () => {
      await store.record(createTestInput({ type: TransactionType.RECEIVED }));
      await store.record(createTestInput({ type: TransactionType.SENT }));

      expect(await store.count({ type: TransactionType.RECEIVED })).toBe(1);
    });
  });

  describe('exists()', () => {
    it('should return true for existing transaction', async () => {
      const tx = await store.record(createTestInput());
      expect(await store.exists(tx.id)).toBe(true);
    });

    it('should return false for non-existent transaction', async () => {
      expect(await store.exists('non-existent')).toBe(false);
    });
  });

  describe('clear()', () => {
    it('should clear all transactions', async () => {
      await store.recordBatch([createTestInput(), createTestInput(), createTestInput()]);
      expect(await store.count()).toBe(3);

      await store.clear();
      expect(await store.count()).toBe(0);
    });
  });

  describe('sync operations', () => {
    it('should get unsynced transactions', async () => {
      const tx1 = await store.record(createTestInput());
      await store.record(createTestInput());
      await store.update(tx1.id, { synced: true });

      const unsynced = await store.getUnsynced();
      expect(unsynced).toHaveLength(1);
    });

    it('should mark transactions as synced', async () => {
      const tx1 = await store.record(createTestInput());
      const tx2 = await store.record(createTestInput());

      await store.markSynced([tx1.id, tx2.id], ['event1', 'event2']);

      const updated1 = await store.get(tx1.id);
      const updated2 = await store.get(tx2.id);

      expect(updated1?.synced).toBe(true);
      expect(updated1?.eventId).toBe('event1');
      expect(updated2?.synced).toBe(true);
      expect(updated2?.eventId).toBe('event2');
    });

    it('should store and retrieve sync metadata', async () => {
      await store.setSyncMeta('lastSync', 1704067200);
      const value = await store.getSyncMeta('lastSync');
      expect(value).toBe(1704067200);
    });
  });

  describe('getStats()', () => {
    it('should calculate transaction statistics', async () => {
      await store.recordBatch([
        createTestInput({
          type: TransactionType.RECEIVED,
          direction: TransactionDirection.IN,
          tokenAmount: 1000,
          faceValue: 5000,
          faceUnit: 'USD',
        }),
        createTestInput({
          type: TransactionType.RECEIVED,
          direction: TransactionDirection.IN,
          tokenAmount: 2000,
          faceValue: 10000,
          faceUnit: 'USD',
        }),
        createTestInput({
          type: TransactionType.SENT,
          direction: TransactionDirection.OUT,
          tokenAmount: 500,
          faceValue: 2500,
          faceUnit: 'USD',
        }),
      ]);

      const stats = await store.getStats();

      expect(stats.totalIn).toBe(3000);
      expect(stats.totalOut).toBe(500);
      expect(stats.countIn).toBe(2);
      expect(stats.countOut).toBe(1);
      expect(stats.netFlow).toBe(2500);
      expect(stats.byType[TransactionType.RECEIVED].count).toBe(2);
      expect(stats.byType[TransactionType.RECEIVED].total).toBe(3000);
      expect(stats.byUnit['USD'].count).toBe(3);
    });
  });
});

// Helper function to create test inputs
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
