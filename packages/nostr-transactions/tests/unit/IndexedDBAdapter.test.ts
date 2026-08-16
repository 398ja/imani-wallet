/**
 * Tests for IndexedDB Adapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  IndexedDBAdapter,
  TransactionType,
  TransactionDirection,
  type TransactionInput,
} from '../../src';

describe('IndexedDBAdapter', () => {
  let adapter: IndexedDBAdapter;

  beforeEach(async () => {
    adapter = new IndexedDBAdapter({
      dbName: `test-db-${Date.now()}`,
    });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.clear();
    await adapter.close();
  });

  describe('initialization', () => {
    it('should initialize successfully', () => {
      expect(adapter.isInitialized()).toBe(true);
    });

    it('should create database with correct structure', async () => {
      // Test by adding and retrieving a transaction
      const input = createTestInput();
      const tx = await adapter.add(input);
      const retrieved = await adapter.get(tx.id);
      expect(retrieved).not.toBeNull();
    });
  });

  describe('CRUD operations', () => {
    it('should add a transaction', async () => {
      const input = createTestInput();
      const tx = await adapter.add(input);

      expect(tx.id).toBeDefined();
      expect(tx.type).toBe(input.type);
    });

    it('should add batch transactions', async () => {
      const inputs = [
        createTestInput({ faceValue: 100 }),
        createTestInput({ faceValue: 200 }),
      ];
      const transactions = await adapter.addBatch(inputs);

      expect(transactions).toHaveLength(2);
      expect(await adapter.count()).toBe(2);
    });

    it('should get a transaction', async () => {
      const tx = await adapter.add(createTestInput({ memo: 'test' }));
      const retrieved = await adapter.get(tx.id);

      expect(retrieved?.memo).toBe('test');
    });

    it('should get by event ID', async () => {
      const tx = await adapter.add(createTestInput());
      await adapter.update(tx.id, { eventId: 'test-event' });

      const retrieved = await adapter.getByEventId('test-event');
      expect(retrieved?.id).toBe(tx.id);
    });

    it('should update a transaction', async () => {
      const tx = await adapter.add(createTestInput());
      const updated = await adapter.update(tx.id, { memo: 'updated' });

      expect(updated.memo).toBe('updated');
    });

    it('should delete a transaction', async () => {
      const tx = await adapter.add(createTestInput());
      const result = await adapter.delete(tx.id);

      expect(result).toBe(true);
      expect(await adapter.get(tx.id)).toBeNull();
    });

    it('should delete batch transactions', async () => {
      const tx1 = await adapter.add(createTestInput());
      const tx2 = await adapter.add(createTestInput());

      const deleted = await adapter.deleteBatch([tx1.id, tx2.id]);
      expect(deleted).toBe(2);
    });
  });

  describe('query operations', () => {
    beforeEach(async () => {
      const now = Math.floor(Date.now() / 1000);
      await adapter.addBatch([
        createTestInput({
          type: TransactionType.RECEIVED,
          faceValue: 1000,
          timestamp: now - 3600,
        }),
        createTestInput({
          type: TransactionType.SENT,
          faceValue: 2000,
          timestamp: now - 1800,
        }),
        createTestInput({
          type: TransactionType.RECEIVED,
          faceValue: 3000,
          timestamp: now,
        }),
      ]);
    });

    it('should query all transactions', async () => {
      const result = await adapter.query({});
      expect(result.transactions).toHaveLength(3);
    });

    it('should filter by type', async () => {
      const result = await adapter.query({
        type: TransactionType.RECEIVED,
      });
      expect(result.transactions).toHaveLength(2);
    });

    it('should filter by multiple types', async () => {
      const result = await adapter.query({
        type: [TransactionType.RECEIVED, TransactionType.SENT],
      });
      expect(result.transactions).toHaveLength(3);
    });

    it('should apply pagination', async () => {
      const page1 = await adapter.query({ limit: 2, offset: 0 });
      const page2 = await adapter.query({ limit: 2, offset: 2 });

      expect(page1.transactions).toHaveLength(2);
      expect(page1.hasMore).toBe(true);
      expect(page2.transactions).toHaveLength(1);
      expect(page2.hasMore).toBe(false);
    });

    it('should sort by timestamp', async () => {
      const desc = await adapter.query({ sortBy: 'timestamp', sortOrder: 'desc' });
      const asc = await adapter.query({ sortBy: 'timestamp', sortOrder: 'asc' });

      expect(desc.transactions[0].faceValue).toBe(3000);
      expect(asc.transactions[0].faceValue).toBe(1000);
    });

    it('should filter by time range', async () => {
      const now = Math.floor(Date.now() / 1000);
      const result = await adapter.query({
        fromTimestamp: now - 2000,
        toTimestamp: now,
      });
      expect(result.transactions).toHaveLength(2);
    });

    it('should filter by amount range', async () => {
      const result = await adapter.query({
        minAmount: 1500,
        maxAmount: 2500,
      });
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].faceValue).toBe(2000);
    });
  });

  describe('sync operations', () => {
    it('should get unsynced transactions', async () => {
      const tx1 = await adapter.add(createTestInput());
      await adapter.add(createTestInput());
      await adapter.update(tx1.id, { synced: true });

      const unsynced = await adapter.getUnsynced();
      expect(unsynced).toHaveLength(1);
    });

    it('should mark synced', async () => {
      const tx = await adapter.add(createTestInput());
      await adapter.markSynced([tx.id], ['event123']);

      const updated = await adapter.get(tx.id);
      expect(updated?.synced).toBe(true);
      expect(updated?.eventId).toBe('event123');
    });
  });

  describe('sync metadata', () => {
    it('should store sync metadata', async () => {
      await adapter.setSyncMeta('lastSync', 12345);
      const value = await adapter.getSyncMeta('lastSync');
      expect(value).toBe(12345);
    });

    it('should get all sync metadata', async () => {
      await adapter.setSyncMeta('key1', 'value1');
      await adapter.setSyncMeta('key2', 'value2');

      const all = await adapter.getAllSyncMeta();
      expect(all.key1).toBe('value1');
      expect(all.key2).toBe('value2');
    });

    it('should clear sync metadata', async () => {
      await adapter.setSyncMeta('key', 'value');
      await adapter.clearSyncMeta();

      const value = await adapter.getSyncMeta('key');
      expect(value).toBeUndefined();
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
