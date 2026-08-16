import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryCacheStore, createMemoryCache } from '../../src/cache/MemoryCacheStore.js';

describe('MemoryCacheStore', () => {
  let cache: MemoryCacheStore<string>;

  beforeEach(() => {
    cache = new MemoryCacheStore<string>({
      defaultTtlMs: 1000,
      maxSize: 3,
    });
  });

  describe('get/set', () => {
    it('should store and retrieve values', async () => {
      await cache.set('key1', 'value1');
      const result = await cache.get('key1');
      expect(result).toBe('value1');
    });

    it('should return null for non-existent keys', async () => {
      const result = await cache.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should overwrite existing values', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key1', 'value2');
      const result = await cache.get('key1');
      expect(result).toBe('value2');
    });
  });

  describe('TTL expiration', () => {
    it('should return null for expired entries', async () => {
      vi.useFakeTimers();

      await cache.set('key1', 'value1', 100);

      // Advance time past TTL
      vi.advanceTimersByTime(101);

      const result = await cache.get('key1');
      expect(result).toBeNull();

      vi.useRealTimers();
    });

    it('should return value before TTL expires', async () => {
      vi.useFakeTimers();

      await cache.set('key1', 'value1', 100);

      // Advance time but not past TTL
      vi.advanceTimersByTime(50);

      const result = await cache.get('key1');
      expect(result).toBe('value1');

      vi.useRealTimers();
    });

    it('should use default TTL when not specified', async () => {
      const entry = cache.getEntry('key1');
      expect(entry).toBeUndefined();

      await cache.set('key1', 'value1');
      const entryAfterSet = cache.getEntry('key1');
      expect(entryAfterSet?.ttlMs).toBe(1000);
    });
  });

  describe('size limit', () => {
    it('should evict oldest entries when size limit is reached', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.set('key3', 'value3');

      // This should evict key1
      await cache.set('key4', 'value4');

      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBe('value2');
      expect(await cache.get('key3')).toBe('value3');
      expect(await cache.get('key4')).toBe('value4');
    });

    it('should not evict when updating existing key', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');
      await cache.set('key3', 'value3');

      // Updating existing key should not trigger eviction
      await cache.set('key1', 'updated');

      expect(await cache.get('key1')).toBe('updated');
      expect(await cache.get('key2')).toBe('value2');
      expect(await cache.get('key3')).toBe('value3');
    });
  });

  describe('delete', () => {
    it('should delete existing entries', async () => {
      await cache.set('key1', 'value1');
      await cache.delete('key1');
      expect(await cache.get('key1')).toBeNull();
    });

    it('should not throw when deleting non-existent entries', async () => {
      await expect(cache.delete('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('has', () => {
    it('should return true for existing entries', async () => {
      await cache.set('key1', 'value1');
      expect(await cache.has('key1')).toBe(true);
    });

    it('should return false for non-existent entries', async () => {
      expect(await cache.has('nonexistent')).toBe(false);
    });

    it('should return false for expired entries', async () => {
      vi.useFakeTimers();

      await cache.set('key1', 'value1', 100);
      vi.advanceTimersByTime(101);

      expect(await cache.has('key1')).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('clear', () => {
    it('should remove all entries', async () => {
      await cache.set('key1', 'value1');
      await cache.set('key2', 'value2');

      await cache.clear();

      expect(await cache.size()).toBe(0);
      expect(await cache.get('key1')).toBeNull();
      expect(await cache.get('key2')).toBeNull();
    });

    it('should reset stats', async () => {
      await cache.set('key1', 'value1');
      await cache.get('key1'); // hit
      await cache.get('nonexistent'); // miss

      await cache.clear();

      const stats = await cache.stats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('size', () => {
    it('should return correct count', async () => {
      expect(await cache.size()).toBe(0);

      await cache.set('key1', 'value1');
      expect(await cache.size()).toBe(1);

      await cache.set('key2', 'value2');
      expect(await cache.size()).toBe(2);
    });

    it('should not count expired entries', async () => {
      vi.useFakeTimers();

      await cache.set('key1', 'value1', 100);
      await cache.set('key2', 'value2', 1000);

      vi.advanceTimersByTime(101);

      expect(await cache.size()).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('stats', () => {
    it('should track hits and misses', async () => {
      await cache.set('key1', 'value1');

      await cache.get('key1'); // hit
      await cache.get('key1'); // hit
      await cache.get('nonexistent'); // miss

      const stats = await cache.stats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.667, 2);
    });

    it('should return 0 hit rate when no requests', async () => {
      const stats = await cache.stats();
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('createMemoryCache factory', () => {
    it('should create cache with defaults', () => {
      const defaultCache = createMemoryCache<string>();
      expect(defaultCache).toBeInstanceOf(MemoryCacheStore);
    });

    it('should accept custom options', async () => {
      const customCache = createMemoryCache<string>({
        defaultTtlMs: 5000,
        maxSize: 50,
      });

      await customCache.set('key', 'value');
      const entry = customCache.getEntry('key');
      expect(entry?.ttlMs).toBe(5000);
    });
  });
});
