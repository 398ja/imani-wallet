import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Nip05Resolver, createNip05Resolver } from '../../src/core/Nip05Resolver.js';
import { MemoryCacheStore } from '../../src/cache/MemoryCacheStore.js';
import { ProfileError, ProfileErrorCode } from '../../src/types/errors.js';
import type { Nip05Result } from '../../src/types/index.js';

describe('Nip05Resolver', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createResolver(options: { cache?: MemoryCacheStore<Nip05Result> } = {}) {
    return new Nip05Resolver({
      fetch: mockFetch,
      timeoutMs: 5000,
      cache: options.cache,
    });
  }

  function mockSuccessResponse(names: Record<string, string>, relays?: Record<string, string[]>) {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ names, relays }),
    });
  }

  function mockNotFoundResponse() {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    });
  }

  describe('resolve', () => {
    it('should resolve valid NIP-05 identifier', async () => {
      const resolver = createResolver();
      const pubkey = 'a'.repeat(64);

      mockSuccessResponse({ alice: pubkey }, { [pubkey]: ['wss://relay1.com'] });

      const result = await resolver.resolve('alice@example.com');

      expect(result).toEqual({
        pubkey,
        relays: ['wss://relay1.com'],
        identifier: 'alice@example.com',
      });
    });

    it('should make request to correct well-known URL', async () => {
      const resolver = createResolver();
      const pubkey = 'a'.repeat(64);

      mockSuccessResponse({ bob: pubkey });

      await resolver.resolve('bob@nostr.example.org');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://nostr.example.org/.well-known/nostr.json?name=bob',
        expect.objectContaining({
          headers: { Accept: 'application/json' },
        })
      );
    });

    it('should return null when name not found', async () => {
      const resolver = createResolver();

      mockSuccessResponse({ alice: 'a'.repeat(64) });

      const result = await resolver.resolve('bob@example.com');

      expect(result).toBeNull();
    });

    it('should return null on 404 response', async () => {
      const resolver = createResolver();

      mockNotFoundResponse();

      const result = await resolver.resolve('alice@example.com');

      expect(result).toBeNull();
    });

    it('should handle case-insensitive lookup', async () => {
      const resolver = createResolver();
      const pubkey = 'a'.repeat(64);

      mockSuccessResponse({ alice: pubkey });

      const result = await resolver.resolve('ALICE@example.com');

      expect(result?.pubkey).toBe(pubkey);
    });

    it('should throw validation error for invalid identifier', async () => {
      const resolver = createResolver();

      await expect(resolver.resolve('invalid')).rejects.toThrow(ProfileError);
      await expect(resolver.resolve('invalid')).rejects.toMatchObject({
        code: ProfileErrorCode.VALIDATION_ERROR,
      });
    });

    it('should throw on network error', async () => {
      const resolver = createResolver();

      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(resolver.resolve('alice@example.com')).rejects.toMatchObject({
        code: ProfileErrorCode.NIP05_RESOLUTION_FAILED,
      });
    });

    it('should handle empty relays', async () => {
      const resolver = createResolver();
      const pubkey = 'a'.repeat(64);

      mockSuccessResponse({ alice: pubkey });

      const result = await resolver.resolve('alice@example.com');

      expect(result?.relays).toEqual([]);
    });

    it('should deduplicate concurrent requests for same identifier', async () => {
      const resolver = createResolver();
      const pubkey = 'a'.repeat(64);

      mockSuccessResponse({ alice: pubkey });

      // Make concurrent requests
      const [result1, result2, result3] = await Promise.all([
        resolver.resolve('alice@example.com'),
        resolver.resolve('alice@example.com'),
        resolver.resolve('alice@example.com'),
      ]);

      // All should return same result
      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);

      // But fetch should only be called once
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveWithCache', () => {
    it('should cache resolved results', async () => {
      const cache = new MemoryCacheStore<Nip05Result>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });
      const resolver = createResolver({ cache });
      const pubkey = 'a'.repeat(64);

      mockSuccessResponse({ alice: pubkey });

      // First call should fetch
      await resolver.resolveWithCache('alice@example.com');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const result = await resolver.resolveWithCache('alice@example.com');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result?.pubkey).toBe(pubkey);
    });

    it('should return cached result without fetching', async () => {
      const cache = new MemoryCacheStore<Nip05Result>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });
      const resolver = createResolver({ cache });
      const pubkey = 'a'.repeat(64);

      // Pre-populate cache
      await cache.set('nip05:alice@example.com', {
        pubkey,
        relays: ['wss://cached-relay.com'],
        identifier: 'alice@example.com',
      });

      const result = await resolver.resolveWithCache('alice@example.com');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result?.relays).toEqual(['wss://cached-relay.com']);
    });

    it('should not cache null results', async () => {
      const cache = new MemoryCacheStore<Nip05Result>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });
      const resolver = createResolver({ cache });

      mockSuccessResponse({});

      await resolver.resolveWithCache('unknown@example.com');

      const cached = await cache.get('nip05:unknown@example.com');
      expect(cached).toBeNull();
    });
  });

  describe('timeout handling', () => {
    it('should throw on abort error', async () => {
      const resolver = new Nip05Resolver({
        fetch: mockFetch,
        timeoutMs: 100,
      });

      // Create a request that immediately aborts
      mockFetch.mockImplementation(() => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      await expect(resolver.resolve('alice@example.com')).rejects.toMatchObject({
        code: ProfileErrorCode.NIP05_RESOLUTION_FAILED,
      });
    });
  });

  describe('createNip05Resolver factory', () => {
    it('should create resolver with default config', () => {
      const resolver = createNip05Resolver();
      expect(resolver).toBeInstanceOf(Nip05Resolver);
    });

    it('should create resolver with custom config', () => {
      const cache = new MemoryCacheStore<Nip05Result>({
        defaultTtlMs: 60000,
        maxSize: 100,
      });

      const resolver = createNip05Resolver({
        cache,
        timeoutMs: 10000,
      });

      expect(resolver).toBeInstanceOf(Nip05Resolver);
    });
  });
});
