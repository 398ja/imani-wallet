import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  NostrLookupAdapter,
  createNostrLookupAdapter,
  type NostrPool,
  type NostrEvent,
} from '../../src/index.js';

describe('NostrLookupAdapter', () => {
  const validPubkey = 'a'.repeat(64);
  const validPubkey2 = 'b'.repeat(64);
  const relays = ['wss://relay1.example.com', 'wss://relay2.example.com'];

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

  const createMerchantEvent = (
    pubkey: string,
    metadata: Record<string, unknown>,
    created_at = Math.floor(Date.now() / 1000)
  ): NostrEvent => ({
    id: 'merchant-' + pubkey.slice(0, 8),
    pubkey,
    created_at,
    kind: 30078,
    tags: [['d', 'merchant-profile']],
    content: JSON.stringify(metadata),
    sig: 'sig-' + pubkey.slice(0, 8),
  });

  describe('factory function', () => {
    it('should create an instance', () => {
      const pool = createMockPool();
      const adapter = createNostrLookupAdapter({ relays, pool });
      expect(adapter).toBeInstanceOf(NostrLookupAdapter);
    });
  });

  describe('getProfile', () => {
    it('should return null for invalid pubkey', async () => {
      const pool = createMockPool();
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfile('invalid');
      expect(result).toBeNull();
    });

    it('should return null when no events found', async () => {
      const pool = createMockPool([]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfile(validPubkey);
      expect(result).toBeNull();
    });

    it('should return profile from event', async () => {
      const event = createProfileEvent(validPubkey, {
        name: 'Test User',
        display_name: 'Test Display',
        picture: 'https://example.com/pic.jpg',
        about: 'A test user',
        nip05: 'test@example.com',
        lud16: 'test@lightning.example.com',
      });

      const pool = createMockPool([event]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfile(validPubkey);

      expect(result).not.toBeNull();
      expect(result?.pubkey).toBe(validPubkey);
      expect(result?.name).toBe('Test User');
      expect(result?.displayName).toBe('Test Display');
      expect(result?.picture).toBe('https://example.com/pic.jpg');
      expect(result?.about).toBe('A test user');
      expect(result?.nip05).toBe('test@example.com');
      expect(result?.lud16).toBe('test@lightning.example.com');
    });

    it('should normalize uppercase pubkey', async () => {
      const event = createProfileEvent(validPubkey, { name: 'Test' });
      const pool = createMockPool([event]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      await adapter.getProfile(validPubkey.toUpperCase());

      expect(pool.querySync).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          authors: [validPubkey],
        })
      );
    });

    it('should use latest event when multiple exist', async () => {
      const oldEvent = createProfileEvent(validPubkey, { name: 'Old Name' }, 1000);
      const newEvent = createProfileEvent(validPubkey, { name: 'New Name' }, 2000);

      const pool = createMockPool([oldEvent, newEvent]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfile(validPubkey);

      expect(result?.name).toBe('New Name');
    });

    it('should extract merchant fields', async () => {
      const event = createProfileEvent(validPubkey, {
        name: 'Merchant',
        currencies: ['USD', 'EUR'],
        merchantTags: ['merchant', 'pos'],
      });

      const pool = createMockPool([event]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfile(validPubkey);

      expect(result?.currencies).toEqual(['USD', 'EUR']);
      expect(result?.merchantTags).toEqual(['merchant', 'pos']);
    });

    it('should extract location', async () => {
      const event = createProfileEvent(validPubkey, {
        name: 'Located User',
        location: {
          lat: 40.7128,
          lon: -74.006,
          city: 'New York',
          country: 'US',
        },
      });

      const pool = createMockPool([event]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfile(validPubkey);

      expect(result?.location).toEqual({
        lat: 40.7128,
        lon: -74.006,
        city: 'New York',
        country: 'US',
        address: undefined,
      });
    });

    it('should handle malformed JSON gracefully', async () => {
      const event: NostrEvent = {
        id: 'bad-event',
        pubkey: validPubkey,
        created_at: 1000,
        kind: 0,
        tags: [],
        content: 'not valid json',
        sig: 'sig',
      };

      const pool = createMockPool([event]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfile(validPubkey);
      expect(result).toBeNull();
    });

    it('should timeout on slow queries', async () => {
      const pool: NostrPool = {
        querySync: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve([]), 10000))
        ),
      };

      const adapter = new NostrLookupAdapter({ relays, pool, timeoutMs: 100 });
      const result = await adapter.getProfile(validPubkey);

      expect(result).toBeNull();
    });
  });

  describe('getProfiles', () => {
    it('should return empty array for empty input', async () => {
      const pool = createMockPool();
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfiles([]);
      expect(result).toEqual([]);
    });

    it('should filter invalid pubkeys', async () => {
      const event = createProfileEvent(validPubkey, { name: 'Test' });
      const pool = createMockPool([event]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      await adapter.getProfiles([validPubkey, 'invalid', validPubkey2]);

      expect(pool.querySync).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          authors: [validPubkey, validPubkey2],
        })
      );
    });

    it('should deduplicate pubkeys', async () => {
      const event = createProfileEvent(validPubkey, { name: 'Test' });
      const pool = createMockPool([event]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      await adapter.getProfiles([validPubkey, validPubkey, validPubkey.toUpperCase()]);

      expect(pool.querySync).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          authors: [validPubkey],
        })
      );
    });

    it('should return profiles for multiple pubkeys', async () => {
      const event1 = createProfileEvent(validPubkey, { name: 'User 1' });
      const event2 = createProfileEvent(validPubkey2, { name: 'User 2' });

      const pool = createMockPool([event1, event2]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getProfiles([validPubkey, validPubkey2]);

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.name)).toContain('User 1');
      expect(result.map((p) => p.name)).toContain('User 2');
    });
  });

  describe('getMerchantProfile', () => {
    it('should return null for invalid pubkey', async () => {
      const pool = createMockPool();
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getMerchantProfile('invalid');
      expect(result).toBeNull();
    });

    it('should return null when no merchant profile exists', async () => {
      const pool = createMockPool([]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getMerchantProfile(validPubkey);
      expect(result).toBeNull();
    });

    it('should return merchant profile from event', async () => {
      const event = createMerchantEvent(validPubkey, {
        business_name: 'Test Business',
        business_type: 'retail',
        currencies: ['USD', 'EUR'],
        payment_methods: ['cashu', 'lightning'],
        verified: true,
      });

      const pool = createMockPool([event]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      const result = await adapter.getMerchantProfile(validPubkey);

      expect(result).not.toBeNull();
      expect(result?.pubkey).toBe(validPubkey);
      expect(result?.businessName).toBe('Test Business');
      expect(result?.businessType).toBe('retail');
      expect(result?.currencies).toEqual(['USD', 'EUR']);
      expect(result?.paymentMethods).toEqual(['cashu', 'lightning']);
      expect(result?.verified).toBe(true);
    });

    it('should query with correct kind and d-tag', async () => {
      const pool = createMockPool([]);
      const adapter = new NostrLookupAdapter({ relays, pool });

      await adapter.getMerchantProfile(validPubkey);

      expect(pool.querySync).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          kinds: [30078],
          authors: [validPubkey],
          '#d': ['merchant-profile'],
        })
      );
    });

    it('should support custom merchant kind', async () => {
      const pool = createMockPool([]);
      const adapter = new NostrLookupAdapter({ relays, pool, merchantKind: 30079 });

      await adapter.getMerchantProfile(validPubkey);

      expect(pool.querySync).toHaveBeenCalledWith(
        relays,
        expect.objectContaining({
          kinds: [30079],
        })
      );
    });
  });

  describe('close', () => {
    it('should close the pool', () => {
      const pool = createMockPool();
      const adapter = new NostrLookupAdapter({ relays, pool });

      adapter.close();

      expect(pool.close).toHaveBeenCalledWith(relays);
    });

    it('should handle pools without close method', () => {
      const pool: NostrPool = {
        querySync: vi.fn().mockResolvedValue([]),
      };
      const adapter = new NostrLookupAdapter({ relays, pool });

      expect(() => adapter.close()).not.toThrow();
    });
  });
});
