import { describe, it, expect, beforeEach } from 'vitest';
import {
  MemoryFollowAdapter,
  LocalFollowAdapter,
  createLocalFollowAdapter,
} from '../../src/index.js';

describe('MemoryFollowAdapter', () => {
  let adapter: MemoryFollowAdapter;

  const validPubkey1 = 'a'.repeat(64);
  const validPubkey2 = 'b'.repeat(64);
  const validPubkey3 = 'c'.repeat(64);

  beforeEach(() => {
    adapter = new MemoryFollowAdapter();
  });

  describe('basic operations', () => {
    it('should start empty', async () => {
      const list = await adapter.list();
      expect(list).toEqual([]);
    });

    it('should add a pubkey', async () => {
      await adapter.add(validPubkey1);
      const list = await adapter.list();
      expect(list).toContain(validPubkey1);
    });

    it('should remove a pubkey', async () => {
      await adapter.add(validPubkey1);
      await adapter.remove(validPubkey1);
      const list = await adapter.list();
      expect(list).not.toContain(validPubkey1);
    });

    it('should check if pubkey exists', async () => {
      expect(await adapter.has(validPubkey1)).toBe(false);
      await adapter.add(validPubkey1);
      expect(await adapter.has(validPubkey1)).toBe(true);
    });

    it('should clear all pubkeys', async () => {
      await adapter.add(validPubkey1);
      await adapter.add(validPubkey2);
      await adapter.clear();
      const list = await adapter.list();
      expect(list).toHaveLength(0);
    });
  });

  describe('pubkey normalization', () => {
    it('should normalize pubkeys to lowercase', async () => {
      const uppercasePubkey = validPubkey1.toUpperCase();
      await adapter.add(uppercasePubkey);
      expect(await adapter.has(validPubkey1)).toBe(true);
    });

    it('should handle mixed case on remove', async () => {
      await adapter.add(validPubkey1);
      await adapter.remove(validPubkey1.toUpperCase());
      expect(await adapter.has(validPubkey1)).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should return all entries with metadata', async () => {
      await adapter.add(validPubkey1);
      await adapter.add(validPubkey2);

      const entries = adapter.getAll();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        pubkey: validPubkey1,
        labels: [],
        source: 'local',
      });
      expect(entries[0].createdAt).toBeDefined();
    });
  });

  describe('multiple operations', () => {
    it('should handle multiple adds and removes', async () => {
      await adapter.add(validPubkey1);
      await adapter.add(validPubkey2);
      await adapter.add(validPubkey3);
      await adapter.remove(validPubkey2);

      const list = await adapter.list();
      expect(list).toContain(validPubkey1);
      expect(list).not.toContain(validPubkey2);
      expect(list).toContain(validPubkey3);
    });

    it('should not duplicate pubkeys on multiple adds', async () => {
      await adapter.add(validPubkey1);
      await adapter.add(validPubkey1);
      await adapter.add(validPubkey1);

      const list = await adapter.list();
      expect(list.filter((p) => p === validPubkey1)).toHaveLength(1);
    });

    it('should handle remove of non-existent pubkey', async () => {
      await expect(adapter.remove(validPubkey1)).resolves.not.toThrow();
    });
  });
});

describe('LocalFollowAdapter', () => {
  describe('factory function', () => {
    it('should create an instance', () => {
      const adapter = createLocalFollowAdapter();
      expect(adapter).toBeInstanceOf(LocalFollowAdapter);
    });

    it('should accept custom config', () => {
      const adapter = createLocalFollowAdapter({
        dbName: 'custom-db',
        storeName: 'custom-store',
      });
      expect(adapter).toBeInstanceOf(LocalFollowAdapter);
    });
  });

  // Note: Full IndexedDB tests would require a browser environment or fake-indexeddb
  // These tests verify the class structure and configuration
  describe('class structure', () => {
    it('should implement FollowAdapter interface', () => {
      const adapter = new LocalFollowAdapter();

      expect(typeof adapter.list).toBe('function');
      expect(typeof adapter.add).toBe('function');
      expect(typeof adapter.remove).toBe('function');
      expect(typeof adapter.has).toBe('function');
      expect(typeof adapter.clear).toBe('function');
      expect(typeof adapter.close).toBe('function');
    });

    it('should have additional methods', () => {
      const adapter = new LocalFollowAdapter();

      expect(typeof adapter.getEntry).toBe('function');
      expect(typeof adapter.listEntries).toBe('function');
      expect(typeof adapter.updateLabels).toBe('function');
      expect(typeof adapter.getByLabel).toBe('function');
    });
  });

  describe('without IndexedDB', () => {
    it('should throw when IndexedDB is not available', async () => {
      const adapter = new LocalFollowAdapter();
      // In Node.js environment, indexedDB is undefined
      await expect(adapter.list()).rejects.toThrow('IndexedDB is not available');
    });
  });
});
