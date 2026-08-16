import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileDirectory, createProfileDirectory } from '../../src/core/ProfileDirectory.js';
import { MemoryCacheStore } from '../../src/cache/MemoryCacheStore.js';
import type {
  Profile,
  ProfileFilter,
  ProfileSearchResult,
  DirectoryAdapter,
} from '../../src/types/index.js';

// Helper to create test profiles
function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    pubkey: Math.random().toString(36).substring(2).padEnd(64, '0'),
    name: 'Test User',
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// Create mock adapter
function createMockAdapter(profiles: Profile[] = []): DirectoryAdapter {
  return {
    search: vi.fn().mockResolvedValue({
      profiles,
      cursor: undefined,
    }),
    suggest: vi.fn().mockResolvedValue([]),
  };
}

describe('ProfileDirectory', () => {
  let mockAdapter: DirectoryAdapter;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
  });

  describe('search', () => {
    it('should return profiles from adapter', async () => {
      const profiles = [
        createProfile({ name: 'Alice' }),
        createProfile({ name: 'Bob' }),
      ];
      mockAdapter = createMockAdapter(profiles);

      const directory = new ProfileDirectory({ adapter: mockAdapter });
      const result = await directory.search();

      expect(result.profiles).toHaveLength(2);
      expect(mockAdapter.search).toHaveBeenCalled();
    });

    it('should apply client-side filtering when adapter lacks capability', async () => {
      const profiles = [
        createProfile({ name: 'Coffee Shop', merchantTags: ['merchant'] }),
        createProfile({ name: 'Tea House', merchantTags: [] }),
      ];
      mockAdapter = createMockAdapter(profiles);

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        capabilities: {}, // No server-side filtering
      });

      const result = await directory.search({ merchantOnly: true });

      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0].name).toBe('Coffee Shop');
    });

    it('should pass filter to adapter when it has capability', async () => {
      mockAdapter = createMockAdapter([createProfile()]);

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        capabilities: { query: true },
      });

      await directory.search({ query: 'test' });

      expect(mockAdapter.search).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'test' })
      );
    });

    it('should apply scoring and sorting', async () => {
      const profiles = [
        createProfile({ name: 'Tea Shop' }),
        createProfile({ name: 'Coffee Shop' }),
        createProfile({ name: 'Best Coffee' }),
      ];
      mockAdapter = createMockAdapter(profiles);

      const directory = new ProfileDirectory({ adapter: mockAdapter });
      const result = await directory.search({ query: 'coffee', limit: 10 });

      // Only Coffee matches should be included (client-side filtering removes Tea Shop)
      expect(result.profiles).toHaveLength(2);
      expect(result.profiles[0].name).toContain('Coffee');
      expect(result.profiles[1].name).toContain('Coffee');
    });

    it('should respect limit', async () => {
      const profiles = Array.from({ length: 50 }, (_, i) =>
        createProfile({ name: `Profile ${i}` })
      );
      mockAdapter = createMockAdapter(profiles);

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        defaultLimit: 20,
      });

      const result = await directory.search({ limit: 10 });

      expect(result.profiles).toHaveLength(10);
    });

    it('should enforce max limit', async () => {
      const profiles = Array.from({ length: 200 }, (_, i) =>
        createProfile({ name: `Profile ${i}` })
      );
      mockAdapter = createMockAdapter(profiles);

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        maxLimit: 100,
      });

      const result = await directory.search({ limit: 500 });

      expect(result.profiles).toHaveLength(100);
    });

    it('should handle pagination', async () => {
      const profiles = Array.from({ length: 30 }, (_, i) =>
        createProfile({ name: `Profile ${i}` })
      );
      mockAdapter = createMockAdapter(profiles);

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        capabilities: {}, // Client-side pagination
      });

      // First page
      const page1 = await directory.search({ limit: 10 });
      expect(page1.profiles).toHaveLength(10);
      expect(page1.cursor).toBeDefined();

      // Second page
      const page2 = await directory.search({ limit: 10, cursor: page1.cursor });
      expect(page2.profiles).toHaveLength(10);
      expect(page2.profiles[0].name).not.toBe(page1.profiles[0].name);
    });
  });

  describe('caching', () => {
    it('should cache search results', async () => {
      const profiles = [createProfile({ name: 'Alice' })];
      mockAdapter = createMockAdapter(profiles);
      const cache = new MemoryCacheStore<ProfileSearchResult>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        cache,
      });

      // First search
      await directory.search({ query: 'test' });
      expect(mockAdapter.search).toHaveBeenCalledTimes(1);

      // Second search with same filter
      await directory.search({ query: 'test' });
      expect(mockAdapter.search).toHaveBeenCalledTimes(1); // Still 1, used cache
    });

    it('should not use cache for different filters', async () => {
      mockAdapter = createMockAdapter([createProfile()]);
      const cache = new MemoryCacheStore<ProfileSearchResult>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        cache,
      });

      await directory.search({ query: 'alice' });
      await directory.search({ query: 'bob' });

      expect(mockAdapter.search).toHaveBeenCalledTimes(2);
    });

    it('should clear cache', async () => {
      const cache = new MemoryCacheStore<ProfileSearchResult>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });

      const directory = new ProfileDirectory({
        adapter: createMockAdapter([createProfile()]),
        cache,
      });

      await directory.search({ query: 'test' });
      expect(await cache.size()).toBe(1);

      await directory.clearCache();
      expect(await cache.size()).toBe(0);
    });
  });

  describe('suggest', () => {
    it('should return suggestions from adapter', async () => {
      mockAdapter = {
        search: vi.fn().mockResolvedValue({ profiles: [] }),
        suggest: vi.fn().mockResolvedValue(['coffee', 'coffee shop']),
      };

      const directory = new ProfileDirectory({ adapter: mockAdapter });
      const suggestions = await directory.suggest('cof');

      expect(suggestions).toEqual(['coffee', 'coffee shop']);
      expect(mockAdapter.suggest).toHaveBeenCalledWith('cof');
    });

    it('should return empty array if adapter does not support suggest', async () => {
      mockAdapter = {
        search: vi.fn().mockResolvedValue({ profiles: [] }),
        // No suggest method
      };

      const directory = new ProfileDirectory({ adapter: mockAdapter });
      const suggestions = await directory.suggest('test');

      expect(suggestions).toEqual([]);
    });
  });

  describe('searchAll', () => {
    it('should iterate through all pages', async () => {
      let callCount = 0;
      mockAdapter = {
        search: vi.fn().mockImplementation(async (filter: ProfileFilter) => {
          callCount++;
          const offset = filter.cursor ? parseInt(atob(filter.cursor), 10) : 0;
          const profiles = Array.from({ length: 10 }, (_, i) =>
            createProfile({ name: `Profile ${offset + i}` })
          );
          return {
            profiles,
            cursor: callCount < 3 ? btoa((offset + 10).toString()) : undefined,
          };
        }),
      };

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        capabilities: { pagination: true }, // Enable server-side pagination
      });
      const allProfiles: Profile[] = [];

      for await (const batch of directory.searchAll({ limit: 10 })) {
        allProfiles.push(...batch);
      }

      expect(allProfiles).toHaveLength(30);
      expect(callCount).toBe(3);
    });
  });

  describe('filter combinations', () => {
    it('should handle merchant + currency + location filter', async () => {
      const profiles = [
        createProfile({
          name: 'Perfect Match',
          merchantTags: ['merchant'],
          currencies: ['USD'],
          location: { lat: 45.5, lon: -122.6 },
        }),
        createProfile({
          name: 'Wrong Currency',
          merchantTags: ['merchant'],
          currencies: ['EUR'],
          location: { lat: 45.5, lon: -122.6 },
        }),
        createProfile({
          name: 'Not Merchant',
          // No merchantTags and no currencies = not a merchant
          location: { lat: 45.5, lon: -122.6 },
        }),
        createProfile({
          name: 'Too Far',
          merchantTags: ['merchant'],
          currencies: ['USD'],
          location: { lat: 50, lon: -122.6 },
        }),
      ];
      mockAdapter = createMockAdapter(profiles);

      const directory = new ProfileDirectory({
        adapter: mockAdapter,
        capabilities: {},
      });

      const result = await directory.search({
        merchantOnly: true,
        currencies: ['USD'],
        location: { lat: 45.5, lon: -122.6, radiusKm: 10 },
      });

      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0].name).toBe('Perfect Match');
    });
  });

  describe('createProfileDirectory factory', () => {
    it('should create directory instance', () => {
      const directory = createProfileDirectory({
        adapter: createMockAdapter(),
      });

      expect(directory).toBeInstanceOf(ProfileDirectory);
    });
  });
});
