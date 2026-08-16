import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  ProfileService,
  createProfileService,
  type ProfileServiceConfig,
} from '../../src/core/ProfileService.js';
import type {
  DirectoryAdapter,
  LookupAdapter,
  FollowAdapter,
  Profile,
  ProfileSearchResult,
  FollowEntry,
  CacheStore,
  ProfileEvent,
} from '../../src/types/index.js';

// Valid 64-character hex pubkeys for testing
const VALID_PUBKEY_1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const VALID_PUBKEY_2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

// Mock adapters
function createMockLookupAdapter(): LookupAdapter {
  return {
    getProfile: vi.fn(),
    getProfiles: vi.fn(),
    getMerchantProfile: vi.fn(),
  };
}

function createMockDirectoryAdapter(): DirectoryAdapter {
  return {
    search: vi.fn().mockResolvedValue({ profiles: [], total: 0 }),
    suggest: vi.fn().mockResolvedValue([]),
  };
}

function createMockFollowAdapter(): FollowAdapter {
  const follows = new Map<string, FollowEntry>();
  return {
    list: vi.fn().mockImplementation(async () => Array.from(follows.keys())),
    add: vi.fn().mockImplementation(async (pubkey: string) => {
      follows.set(pubkey, {
        pubkey,
        labels: [],
        createdAt: Date.now(),
        source: 'local',
      });
    }),
    remove: vi.fn().mockImplementation(async (pubkey: string) => {
      follows.delete(pubkey);
    }),
    clear: vi.fn().mockImplementation(async () => {
      follows.clear();
    }),
    has: vi.fn().mockImplementation(async (pubkey: string) => follows.has(pubkey)),
    getEntry: vi.fn().mockImplementation(async (pubkey: string) => follows.get(pubkey) ?? null),
    listEntries: vi.fn().mockImplementation(async () => Array.from(follows.values())),
    updateLabels: vi.fn(),
    getByLabel: vi.fn().mockImplementation(async () => []),
  };
}

function createMockCache(): CacheStore<Profile> {
  const cache = new Map<string, Profile>();
  return {
    get: vi.fn().mockImplementation(async (key: string) => cache.get(key) ?? null),
    set: vi.fn().mockImplementation(async (key: string, value: Profile) => {
      cache.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      cache.delete(key);
    }),
    has: vi.fn().mockImplementation(async (key: string) => cache.has(key)),
    clear: vi.fn().mockImplementation(async () => {
      cache.clear();
    }),
    size: vi.fn().mockImplementation(async () => cache.size),
    stats: vi.fn().mockImplementation(async () => ({
      entries: cache.size,
      hits: 0,
      misses: 0,
      hitRate: 0,
    })),
  };
}

function createTestProfile(pubkey: string, overrides: Partial<Profile> = {}): Profile {
  return {
    pubkey,
    name: `user-${pubkey.slice(0, 8)}`,
    displayName: `User ${pubkey.slice(0, 8)}`,
    about: 'Test user',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('ProfileService', () => {
  let service: ProfileService;
  let lookupAdapter: LookupAdapter;
  let directoryAdapter: DirectoryAdapter;
  let followAdapter: FollowAdapter;
  let cache: CacheStore<Profile>;
  let eventListener: Mock;

  beforeEach(() => {
    lookupAdapter = createMockLookupAdapter();
    directoryAdapter = createMockDirectoryAdapter();
    followAdapter = createMockFollowAdapter();
    cache = createMockCache();
    eventListener = vi.fn();

    const config: ProfileServiceConfig = {
      lookupAdapter,
      directoryAdapter,
      followAdapter,
      cache,
      onEvent: eventListener,
    };

    service = createProfileService(config);
  });

  describe('search operations', () => {
    it('should search profiles', async () => {
      const profiles = [
        createTestProfile(VALID_PUBKEY_1),
        createTestProfile(VALID_PUBKEY_2),
      ];
      const searchResult: ProfileSearchResult = {
        profiles,
        total: 2,
      };
      (directoryAdapter.search as Mock).mockResolvedValue(searchResult);

      const result = await service.search({ query: 'test' });

      // ProfileDirectory wraps adapter and applies pagination, so profiles should be returned
      expect(result.profiles).toHaveLength(2);
      expect(directoryAdapter.search).toHaveBeenCalled();
    });

    it('should emit searchExecuted event', async () => {
      const searchResult: ProfileSearchResult = {
        profiles: [createTestProfile(VALID_PUBKEY_1)],
        total: 1,
      };
      (directoryAdapter.search as Mock).mockResolvedValue(searchResult);

      await service.search({ query: 'bitcoin' });

      // Check that searchExecuted was emitted
      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'searchExecuted',
        })
      );
    });

    it('should get suggestions', async () => {
      const suggestions = ['bitcoin', 'btc', 'blockchain'];
      (directoryAdapter.suggest as Mock).mockResolvedValue(suggestions);

      const result = await service.suggest('bit');

      expect(result).toEqual(suggestions);
      expect(directoryAdapter.suggest).toHaveBeenCalledWith('bit');
    });
  });

  describe('lookup operations', () => {
    it('should get profile by pubkey', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);
      (lookupAdapter.getProfile as Mock).mockResolvedValue(profile);

      const result = await service.getProfile(VALID_PUBKEY_1);

      expect(result).toEqual(profile);
      expect(lookupAdapter.getProfile).toHaveBeenCalledWith(VALID_PUBKEY_1);
    });

    it('should cache profile after lookup', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);
      (lookupAdapter.getProfile as Mock).mockResolvedValue(profile);

      await service.getProfile(VALID_PUBKEY_1);

      expect(cache.set).toHaveBeenCalledWith(`profile:${VALID_PUBKEY_1}`, profile);
    });

    it('should return cached profile', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);
      (cache.get as Mock).mockResolvedValue(profile);

      const result = await service.getProfile(VALID_PUBKEY_1);

      expect(result).toEqual(profile);
      expect(lookupAdapter.getProfile).not.toHaveBeenCalled();
    });

    it('should emit cacheHit event for cached profile', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);
      (cache.get as Mock).mockResolvedValue(profile);

      await service.getProfile(VALID_PUBKEY_1);

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cacheHit',
          key: `profile:${VALID_PUBKEY_1}`,
        })
      );
    });

    it('should emit cacheMiss event for uncached profile', async () => {
      (cache.get as Mock).mockResolvedValue(null);
      (lookupAdapter.getProfile as Mock).mockResolvedValue(createTestProfile(VALID_PUBKEY_1));

      await service.getProfile(VALID_PUBKEY_1);

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'cacheMiss',
          key: `profile:${VALID_PUBKEY_1}`,
        })
      );
    });

    it('should emit profileViewed event', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);
      (lookupAdapter.getProfile as Mock).mockResolvedValue(profile);

      await service.getProfile(VALID_PUBKEY_1);

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'profileViewed',
          pubkey: VALID_PUBKEY_1,
        })
      );
    });

    it('should get multiple profiles', async () => {
      const profiles = [
        createTestProfile(VALID_PUBKEY_1),
        createTestProfile(VALID_PUBKEY_2),
      ];
      (lookupAdapter.getProfiles as Mock).mockResolvedValue(profiles);

      const result = await service.getProfiles([VALID_PUBKEY_1, VALID_PUBKEY_2]);

      expect(result).toHaveLength(2);
      expect(lookupAdapter.getProfiles).toHaveBeenCalledWith([VALID_PUBKEY_1, VALID_PUBKEY_2]);
    });

    it('should get merchant profile', async () => {
      const merchantProfile = {
        pubkey: VALID_PUBKEY_1,
        businessName: 'Test Shop',
        currencies: ['USD', 'SAT'],
        createdAt: Date.now(),
      };
      (lookupAdapter.getMerchantProfile as Mock).mockResolvedValue(merchantProfile);

      const result = await service.getMerchantProfile(VALID_PUBKEY_1);

      expect(result).toEqual(merchantProfile);
    });

    it('should get full profile', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);
      const merchantProfile = {
        pubkey: VALID_PUBKEY_1,
        businessName: 'Test Shop',
        currencies: ['USD'],
        createdAt: Date.now(),
      };
      (lookupAdapter.getProfile as Mock).mockResolvedValue(profile);
      (lookupAdapter.getMerchantProfile as Mock).mockResolvedValue(merchantProfile);

      const result = await service.getFullProfile(VALID_PUBKEY_1);

      expect(result).toEqual({
        profile,
        merchantProfile,
      });
    });

    it('should return null for non-existent profile in full profile', async () => {
      (lookupAdapter.getProfile as Mock).mockResolvedValue(null);

      const result = await service.getFullProfile(VALID_PUBKEY_1);

      expect(result).toBeNull();
    });
  });

  describe('NIP-05 operations', () => {
    it('should lookup by pubkey directly', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);
      (lookupAdapter.getProfile as Mock).mockResolvedValue(profile);

      const result = await service.lookupByIdentifier(VALID_PUBKEY_1);

      expect(lookupAdapter.getProfile).toHaveBeenCalled();
      expect(result).toEqual(profile);
    });
  });

  describe('follow operations', () => {
    it('should follow a pubkey', async () => {
      await service.follow(VALID_PUBKEY_1);

      expect(followAdapter.add).toHaveBeenCalled();
    });

    it('should unfollow a pubkey that is followed', async () => {
      // First follow the pubkey
      await service.follow(VALID_PUBKEY_1);

      // Then unfollow
      await service.unfollow(VALID_PUBKEY_1);

      expect(followAdapter.remove).toHaveBeenCalledWith(VALID_PUBKEY_1);
    });

    it('should check if following', async () => {
      // Follow first
      await service.follow(VALID_PUBKEY_1);

      const result = await service.isFollowing(VALID_PUBKEY_1);

      expect(result).toBe(true);
    });

    it('should list follows', async () => {
      // Follow both pubkeys
      await service.follow(VALID_PUBKEY_1);
      await service.follow(VALID_PUBKEY_2);

      const result = await service.listFollows();

      expect(result).toContain(VALID_PUBKEY_1);
      expect(result).toContain(VALID_PUBKEY_2);
    });

    it('should toggle follow (follow when not following)', async () => {
      const result = await service.toggleFollow(VALID_PUBKEY_1);

      expect(result).toBe(true);
      expect(followAdapter.add).toHaveBeenCalled();
    });

    it('should toggle follow (unfollow when following)', async () => {
      // First follow
      await service.follow(VALID_PUBKEY_1);

      // Then toggle (should unfollow)
      const result = await service.toggleFollow(VALID_PUBKEY_1);

      expect(result).toBe(false);
      expect(followAdapter.remove).toHaveBeenCalledWith(VALID_PUBKEY_1);
    });

    it('should emit followAdded event', async () => {
      await service.follow(VALID_PUBKEY_1);

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'followAdded',
          pubkey: VALID_PUBKEY_1,
        })
      );
    });

    it('should emit followRemoved event', async () => {
      // Follow first
      await service.follow(VALID_PUBKEY_1);
      eventListener.mockClear();

      // Then unfollow
      await service.unfollow(VALID_PUBKEY_1);

      expect(eventListener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'followRemoved',
          pubkey: VALID_PUBKEY_1,
        })
      );
    });
  });

  describe('profiles with follow status', () => {
    it('should get profiles with follow status', async () => {
      const profiles = [
        createTestProfile(VALID_PUBKEY_1),
        createTestProfile(VALID_PUBKEY_2),
      ];
      (lookupAdapter.getProfiles as Mock).mockResolvedValue(profiles);

      // Follow only first pubkey
      await service.follow(VALID_PUBKEY_1);

      const result = await service.getProfilesWithFollowStatus([VALID_PUBKEY_1, VALID_PUBKEY_2]);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        profile: profiles[0],
        isFollowing: true,
      });
      expect(result[1]).toEqual({
        profile: profiles[1],
        isFollowing: false,
      });
    });

    it('should get followed profiles', async () => {
      const profiles = [createTestProfile(VALID_PUBKEY_1)];

      // Follow a pubkey
      await service.follow(VALID_PUBKEY_1);

      (lookupAdapter.getProfiles as Mock).mockResolvedValue(profiles);

      const result = await service.getFollowedProfiles();

      expect(result).toEqual(profiles);
      expect(lookupAdapter.getProfiles).toHaveBeenCalledWith([VALID_PUBKEY_1]);
    });
  });

  describe('event subscription', () => {
    it('should allow subscribing to events', async () => {
      const listener = vi.fn();
      const unsubscribe = service.on(listener);

      // Trigger an event
      await service.follow(VALID_PUBKEY_1);

      expect(listener).toHaveBeenCalled();

      // Unsubscribe
      unsubscribe();

      // Reset mock
      listener.mockClear();

      // Trigger another event
      await service.follow(VALID_PUBKEY_2);

      // Listener should not be called after unsubscribe
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('cache operations', () => {
    it('should clear cache', async () => {
      await service.clearCache();

      expect(cache.clear).toHaveBeenCalled();
    });
  });

  describe('identifier validation', () => {
    it('should validate valid pubkey', () => {
      expect(service.isValidIdentifier(VALID_PUBKEY_1)).toBe(true);
    });

    it('should validate valid NIP-05', () => {
      expect(service.isValidIdentifier('user@example.com')).toBe(true);
    });

    it('should reject invalid identifier', () => {
      expect(service.isValidIdentifier('invalid')).toBe(false);
    });
  });

  describe('integration: view → follow flow', () => {
    it('should complete view and follow flow', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);

      // Step 1: View a profile
      (lookupAdapter.getProfile as Mock).mockResolvedValue(profile);
      const viewedProfile = await service.getProfile(VALID_PUBKEY_1);
      expect(viewedProfile).toEqual(profile);

      // Step 2: Follow the profile
      await service.follow(VALID_PUBKEY_1);
      expect(followAdapter.add).toHaveBeenCalled();

      // Step 3: Verify following status
      const isFollowing = await service.isFollowing(VALID_PUBKEY_1);
      expect(isFollowing).toBe(true);

      // Step 4: Get followed profiles
      (lookupAdapter.getProfiles as Mock).mockResolvedValue([profile]);
      const followed = await service.getFollowedProfiles();
      expect(followed).toHaveLength(1);
      expect(followed[0].pubkey).toBe(VALID_PUBKEY_1);

      // Step 5: Verify events were emitted
      const eventTypes = eventListener.mock.calls.map((call) => (call[0] as ProfileEvent).type);
      expect(eventTypes).toContain('profileViewed');
      expect(eventTypes).toContain('followAdded');
    });

    it('should handle cache warming on repeated views', async () => {
      const profile = createTestProfile(VALID_PUBKEY_1);
      (lookupAdapter.getProfile as Mock).mockResolvedValue(profile);
      (cache.get as Mock).mockResolvedValueOnce(null); // First call: cache miss

      // First view - should hit adapter and cache
      await service.getProfile(VALID_PUBKEY_1);
      expect(lookupAdapter.getProfile).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalled();

      // Set up cache hit for second call
      (cache.get as Mock).mockResolvedValue(profile);

      // Second view - should hit cache only
      await service.getProfile(VALID_PUBKEY_1);
      expect(lookupAdapter.getProfile).toHaveBeenCalledTimes(1); // Not called again

      // Verify cache events
      const cacheEvents = eventListener.mock.calls
        .map((call) => call[0] as ProfileEvent)
        .filter((e) => e.type === 'cacheHit' || e.type === 'cacheMiss');
      expect(cacheEvents.some((e) => e.type === 'cacheMiss')).toBe(true);
      expect(cacheEvents.some((e) => e.type === 'cacheHit')).toBe(true);
    });
  });
});
