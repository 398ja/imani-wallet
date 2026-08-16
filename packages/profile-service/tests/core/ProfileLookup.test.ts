import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProfileLookup, createProfileLookup } from '../../src/core/ProfileLookup.js';
import { MemoryCacheStore } from '../../src/cache/MemoryCacheStore.js';
import type { Profile, MerchantProfile } from '../../src/types/index.js';

// Mock SimplePool
function createMockPool() {
  return {
    querySync: vi.fn(),
    get: vi.fn(),
    close: vi.fn(),
  };
}

// Helper to create kind-0 profile event
function createProfileEvent(
  pubkey: string,
  metadata: Record<string, unknown>,
  createdAt: number = Date.now() / 1000
) {
  return {
    id: 'event-' + pubkey.slice(0, 8),
    pubkey,
    created_at: createdAt,
    kind: 0,
    tags: [],
    content: JSON.stringify(metadata),
    sig: 'sig-' + pubkey.slice(0, 8),
  };
}

// Helper to create kind-30078 merchant event
function createMerchantEvent(
  pubkey: string,
  metadata: Record<string, unknown>,
  createdAt: number = Date.now() / 1000
) {
  return {
    id: 'merchant-' + pubkey.slice(0, 8),
    pubkey,
    created_at: createdAt,
    kind: 30078,
    tags: [['d', 'merchant-profile']],
    content: JSON.stringify(metadata),
    sig: 'sig-' + pubkey.slice(0, 8),
  };
}

describe('ProfileLookup', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  const relays = ['wss://relay1.com', 'wss://relay2.com'];
  const validPubkey = 'a'.repeat(64);

  beforeEach(() => {
    mockPool = createMockPool();
  });

  function createLookup(options: {
    memoryCache?: MemoryCacheStore<Profile>;
    persistentCache?: MemoryCacheStore<Profile>;
    merchantCache?: MemoryCacheStore<MerchantProfile>;
    staleWhileRevalidate?: boolean;
  } = {}) {
    return new ProfileLookup({
      relays,
      pool: mockPool as unknown as import('nostr-tools').SimplePool,
      memoryCache: options.memoryCache,
      persistentCache: options.persistentCache,
      merchantCache: options.merchantCache,
      staleWhileRevalidate: options.staleWhileRevalidate ?? false,
      timeoutMs: 5000,
    });
  }

  describe('getProfile', () => {
    it('should fetch profile from relays', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(validPubkey, {
          name: 'Alice',
          display_name: 'Alice Wonderland',
          picture: 'https://example.com/alice.jpg',
          about: 'Down the rabbit hole',
          nip05: 'alice@wonderland.com',
        }),
      ]);

      const profile = await lookup.getProfile(validPubkey);

      expect(profile).toMatchObject({
        pubkey: validPubkey,
        name: 'Alice',
        displayName: 'Alice Wonderland',
        picture: 'https://example.com/alice.jpg',
        about: 'Down the rabbit hole',
        nip05: 'alice@wonderland.com',
      });
    });

    it('should return null when profile not found', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([]);

      const profile = await lookup.getProfile(validPubkey);

      expect(profile).toBeNull();
    });

    it('should use most recent event when multiple returned', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(validPubkey, { name: 'Old Name' }, 1000),
        createProfileEvent(validPubkey, { name: 'New Name' }, 2000),
        createProfileEvent(validPubkey, { name: 'Middle Name' }, 1500),
      ]);

      const profile = await lookup.getProfile(validPubkey);

      expect(profile?.name).toBe('New Name');
    });

    it('should normalize pubkey to lowercase', async () => {
      const lookup = createLookup();
      const uppercasePubkey = 'A'.repeat(64);

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(validPubkey, { name: 'Alice' }),
      ]);

      await lookup.getProfile(uppercasePubkey);

      expect(mockPool.querySync).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          authors: [validPubkey],
        })
      );
    });

    it('should throw for invalid pubkey', async () => {
      const lookup = createLookup();

      await expect(lookup.getProfile('invalid')).rejects.toThrow();
    });

    it('should deduplicate concurrent requests', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(validPubkey, { name: 'Alice' }),
      ]);

      const [p1, p2, p3] = await Promise.all([
        lookup.getProfile(validPubkey),
        lookup.getProfile(validPubkey),
        lookup.getProfile(validPubkey),
      ]);

      expect(p1).toEqual(p2);
      expect(p2).toEqual(p3);
      expect(mockPool.querySync).toHaveBeenCalledTimes(1);
    });
  });

  describe('caching', () => {
    it('should return from memory cache if available', async () => {
      const memoryCache = new MemoryCacheStore<Profile>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });
      const lookup = createLookup({ memoryCache });

      // Pre-populate cache
      const cachedProfile: Profile = {
        pubkey: validPubkey,
        name: 'Cached Alice',
      };
      await memoryCache.set(`profile:${validPubkey}`, cachedProfile);

      const profile = await lookup.getProfile(validPubkey);

      expect(profile?.name).toBe('Cached Alice');
      expect(mockPool.querySync).not.toHaveBeenCalled();
    });

    it('should check persistent cache if memory cache misses', async () => {
      const memoryCache = new MemoryCacheStore<Profile>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });
      const persistentCache = new MemoryCacheStore<Profile>({
        defaultTtlMs: 3600000,
        maxSize: 1000,
      });
      const lookup = createLookup({ memoryCache, persistentCache });

      // Only populate persistent cache
      const cachedProfile: Profile = {
        pubkey: validPubkey,
        name: 'Persistent Alice',
      };
      await persistentCache.set(`profile:${validPubkey}`, cachedProfile);

      const profile = await lookup.getProfile(validPubkey);

      expect(profile?.name).toBe('Persistent Alice');
      expect(mockPool.querySync).not.toHaveBeenCalled();

      // Should hydrate memory cache
      const memoryCached = await memoryCache.get(`profile:${validPubkey}`);
      expect(memoryCached?.name).toBe('Persistent Alice');
    });

    it('should cache fetched profiles in all tiers', async () => {
      const memoryCache = new MemoryCacheStore<Profile>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });
      const persistentCache = new MemoryCacheStore<Profile>({
        defaultTtlMs: 3600000,
        maxSize: 1000,
      });
      const lookup = createLookup({ memoryCache, persistentCache });

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(validPubkey, { name: 'Alice' }),
      ]);

      await lookup.getProfile(validPubkey);

      const memoryCached = await memoryCache.get(`profile:${validPubkey}`);
      const persistentCached = await persistentCache.get(`profile:${validPubkey}`);

      expect(memoryCached?.name).toBe('Alice');
      expect(persistentCached?.name).toBe('Alice');
    });
  });

  describe('getProfiles (batch)', () => {
    it('should batch fetch multiple profiles', async () => {
      const lookup = createLookup();
      const pubkey1 = 'a'.repeat(64);
      const pubkey2 = 'b'.repeat(64);
      const pubkey3 = 'c'.repeat(64);

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(pubkey1, { name: 'Alice' }),
        createProfileEvent(pubkey2, { name: 'Bob' }),
        createProfileEvent(pubkey3, { name: 'Charlie' }),
      ]);

      const profiles = await lookup.getProfiles([pubkey1, pubkey2, pubkey3]);

      expect(profiles).toHaveLength(3);
      expect(profiles.map((p) => p.name).sort()).toEqual(['Alice', 'Bob', 'Charlie']);
    });

    it('should return cached profiles without fetching', async () => {
      const memoryCache = new MemoryCacheStore<Profile>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });
      const lookup = createLookup({ memoryCache });

      const pubkey1 = 'a'.repeat(64);
      const pubkey2 = 'b'.repeat(64);

      // Cache one profile
      await memoryCache.set(`profile:${pubkey1}`, {
        pubkey: pubkey1,
        name: 'Cached Alice',
      });

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(pubkey2, { name: 'Bob' }),
      ]);

      const profiles = await lookup.getProfiles([pubkey1, pubkey2]);

      expect(profiles).toHaveLength(2);
      // Should only fetch the uncached one
      expect(mockPool.querySync).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          authors: [pubkey2],
        })
      );
    });

    it('should return empty array for empty input', async () => {
      const lookup = createLookup();

      const profiles = await lookup.getProfiles([]);

      expect(profiles).toEqual([]);
      expect(mockPool.querySync).not.toHaveBeenCalled();
    });

    it('should handle partial results', async () => {
      const lookup = createLookup();
      const pubkey1 = 'a'.repeat(64);
      const pubkey2 = 'b'.repeat(64);

      // Only return one profile
      mockPool.querySync.mockResolvedValue([
        createProfileEvent(pubkey1, { name: 'Alice' }),
      ]);

      const profiles = await lookup.getProfiles([pubkey1, pubkey2]);

      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe('Alice');
    });
  });

  describe('getMerchantProfile', () => {
    it('should fetch merchant profile', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([
        createMerchantEvent(validPubkey, {
          business_name: 'Wonderland Cafe',
          business_type: 'restaurant',
          currencies: ['USD', 'XAF'],
          payment_methods: ['cashu', 'lightning'],
        }),
      ]);

      const merchantProfile = await lookup.getMerchantProfile(validPubkey);

      expect(merchantProfile).toMatchObject({
        pubkey: validPubkey,
        businessName: 'Wonderland Cafe',
        businessType: 'restaurant',
        currencies: ['USD', 'XAF'],
        paymentMethods: ['cashu', 'lightning'],
      });
    });

    it('should return null when merchant profile not found', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([]);

      const merchantProfile = await lookup.getMerchantProfile(validPubkey);

      expect(merchantProfile).toBeNull();
    });

    it('should cache merchant profiles', async () => {
      const merchantCache = new MemoryCacheStore<MerchantProfile>({
        defaultTtlMs: 3600000,
        maxSize: 100,
      });
      const lookup = createLookup({ merchantCache });

      mockPool.querySync.mockResolvedValue([
        createMerchantEvent(validPubkey, {
          business_name: 'Wonderland Cafe',
          currencies: ['USD'],
        }),
      ]);

      // First fetch
      await lookup.getMerchantProfile(validPubkey);

      // Second fetch should use cache
      const cached = await lookup.getMerchantProfile(validPubkey);

      expect(mockPool.querySync).toHaveBeenCalledTimes(1);
      expect(cached?.businessName).toBe('Wonderland Cafe');
    });
  });

  describe('location parsing', () => {
    it('should parse location from profile metadata', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(validPubkey, {
          name: 'Alice',
          location: {
            lat: 4.05,
            lon: 9.7,
            city: 'Douala',
            country: 'Cameroon',
          },
        }),
      ]);

      const profile = await lookup.getProfile(validPubkey);

      expect(profile?.location).toEqual({
        lat: 4.05,
        lon: 9.7,
        city: 'Douala',
        country: 'Cameroon',
      });
    });

    it('should handle lng alias for lon', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(validPubkey, {
          name: 'Alice',
          location: {
            lat: 4.05,
            lng: 9.7, // Using lng instead of lon
          },
        }),
      ]);

      const profile = await lookup.getProfile(validPubkey);

      expect(profile?.location?.lon).toBe(9.7);
    });

    it('should return undefined for invalid location', async () => {
      const lookup = createLookup();

      mockPool.querySync.mockResolvedValue([
        createProfileEvent(validPubkey, {
          name: 'Alice',
          location: {
            lat: 'invalid',
            lon: 9.7,
          },
        }),
      ]);

      const profile = await lookup.getProfile(validPubkey);

      expect(profile?.location).toBeUndefined();
    });
  });

  describe('clearCaches', () => {
    it('should clear all caches', async () => {
      const memoryCache = new MemoryCacheStore<Profile>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });
      const persistentCache = new MemoryCacheStore<Profile>({
        defaultTtlMs: 3600000,
        maxSize: 1000,
      });
      const lookup = createLookup({ memoryCache, persistentCache });

      await memoryCache.set(`profile:${validPubkey}`, { pubkey: validPubkey, name: 'Alice' });
      await persistentCache.set(`profile:${validPubkey}`, { pubkey: validPubkey, name: 'Alice' });

      await lookup.clearCaches();

      expect(await memoryCache.size()).toBe(0);
      expect(await persistentCache.size()).toBe(0);
    });
  });

  describe('createProfileLookup factory', () => {
    it('should create lookup instance', () => {
      const lookup = createProfileLookup({
        relays,
        pool: mockPool as unknown as import('nostr-tools').SimplePool,
      });

      expect(lookup).toBeInstanceOf(ProfileLookup);
    });
  });
});
