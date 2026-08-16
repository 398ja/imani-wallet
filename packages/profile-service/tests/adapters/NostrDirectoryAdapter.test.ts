import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NostrDirectoryAdapter,
  createNostrDirectoryAdapter,
  type NostrPool,
  type NostrEvent,
} from '../../src/index.js';

describe('NostrDirectoryAdapter', () => {
  const relays = ['wss://relay1.example.com'];

  const createMockPool = (events: NostrEvent[] = []): NostrPool => ({
    querySync: vi.fn().mockResolvedValue(events),
    close: vi.fn(),
  });

  const createProfileEvent = (
    pubkey: string,
    metadata: Record<string, unknown>,
    created_at = Math.floor(Date.now() / 1000)
  ): NostrEvent => ({
    id: 'event-' + pubkey.slice(0, 8),
    pubkey,
    created_at,
    kind: 0,
    tags: [],
    content: JSON.stringify(metadata),
    sig: 'sig-' + pubkey.slice(0, 8),
  });

  const sampleProfiles: NostrEvent[] = [
    createProfileEvent('a'.repeat(64), {
      name: 'Coffee Shop',
      about: 'Best coffee in town',
      currencies: ['USD', 'XAF'],
      merchantTags: ['merchant'],
    }),
    createProfileEvent('b'.repeat(64), {
      name: 'Tea House',
      about: 'Premium teas',
      currencies: ['EUR'],
      merchantTags: ['merchant'],
    }),
    createProfileEvent('c'.repeat(64), {
      name: 'Regular User',
      about: 'Just a user',
    }),
  ];

  describe('factory function', () => {
    it('should create an instance', () => {
      const pool = createMockPool();
      const adapter = createNostrDirectoryAdapter({ relays, pool });
      expect(adapter).toBeInstanceOf(NostrDirectoryAdapter);
    });
  });

  describe('search', () => {
    it('should return all profiles with no filter', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const result = await adapter.search({});

      expect(result.profiles.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by query', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const result = await adapter.search({ query: 'coffee' });

      expect(result.profiles.some((p) => p.name?.toLowerCase().includes('coffee'))).toBe(true);
    });

    it('should filter by merchantOnly', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const result = await adapter.search({ merchantOnly: true });

      for (const profile of result.profiles) {
        expect(
          profile.merchantTags?.includes('merchant') ||
            (profile.currencies && profile.currencies.length > 0)
        ).toBe(true);
      }
    });

    it('should filter by currencies', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const result = await adapter.search({ currencies: ['USD'] });

      for (const profile of result.profiles) {
        expect(profile.currencies).toContain('USD');
      }
    });

    it('should paginate results', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const page1 = await adapter.search({ limit: 2 });
      expect(page1.profiles.length).toBe(2);
      expect(page1.cursor).toBeDefined();

      const page2 = await adapter.search({ limit: 2, cursor: page1.cursor });
      expect(page2.profiles.length).toBeGreaterThanOrEqual(1);
    });

    it('should return total count', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const result = await adapter.search({});

      expect(result.totalCount).toBe(3);
    });

    it('should use cache on subsequent requests', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool, enableCache: true });

      await adapter.search({});
      await adapter.search({});
      await adapter.search({});

      expect(pool.querySync).toHaveBeenCalledTimes(1);
    });

    it('should respect cache TTL', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({
        relays,
        pool,
        enableCache: true,
        cacheTtlMs: 50,
      });

      await adapter.search({});

      // Wait for cache to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      await adapter.search({});

      expect(pool.querySync).toHaveBeenCalledTimes(2);
    });

    it('should disable cache when configured', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool, enableCache: false });

      await adapter.search({});
      await adapter.search({});

      expect(pool.querySync).toHaveBeenCalledTimes(2);
    });
  });

  describe('suggest', () => {
    it('should return matching names', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const suggestions = await adapter.suggest('coff');

      expect(suggestions.some((s) => s.toLowerCase().includes('coff'))).toBe(true);
    });

    it('should limit suggestions to 10', async () => {
      const manyProfiles: NostrEvent[] = [];
      for (let i = 0; i < 20; i++) {
        manyProfiles.push(
          createProfileEvent(`${i.toString().padStart(64, 'a')}`, { name: `Test User ${i}` })
        );
      }

      const pool = createMockPool(manyProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const suggestions = await adapter.suggest('test');

      expect(suggestions.length).toBeLessThanOrEqual(10);
    });

    it('should be case-insensitive', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const suggestions = await adapter.suggest('COFFEE');

      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('refresh', () => {
    it('should re-fetch from relays', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool, enableCache: true });

      await adapter.search({});
      await adapter.refresh();

      // refresh itself fetches from relays
      expect(pool.querySync).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearCache', () => {
    it('should clear the cache', async () => {
      const pool = createMockPool(sampleProfiles);
      const adapter = new NostrDirectoryAdapter({ relays, pool, enableCache: true });

      await adapter.search({});
      adapter.clearCache();
      await adapter.search({});

      expect(pool.querySync).toHaveBeenCalledTimes(2);
    });
  });

  describe('close', () => {
    it('should close pool and clear cache', () => {
      const pool = createMockPool();
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      adapter.close();

      expect(pool.close).toHaveBeenCalledWith(relays);
    });
  });

  describe('timeout handling', () => {
    it('should return empty results on timeout', async () => {
      const pool: NostrPool = {
        querySync: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(sampleProfiles), 10000))
        ),
      };

      const adapter = new NostrDirectoryAdapter({ relays, pool, timeoutMs: 50 });
      const result = await adapter.search({});

      expect(result.profiles).toEqual([]);
    });
  });

  describe('latest event selection', () => {
    it('should use newest event per pubkey', async () => {
      const pubkey = 'a'.repeat(64);
      const oldEvent = createProfileEvent(pubkey, { name: 'Old Name' }, 1000);
      const newEvent = createProfileEvent(pubkey, { name: 'New Name' }, 2000);

      const pool = createMockPool([oldEvent, newEvent]);
      const adapter = new NostrDirectoryAdapter({ relays, pool });

      const result = await adapter.search({});

      const profile = result.profiles.find((p) => p.pubkey === pubkey);
      expect(profile?.name).toBe('New Name');
    });
  });
});
