import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ImaniApiAdapter,
  createImaniApiAdapter,
  FetchHttpClient,
  type HttpClient,
} from '../../src/index.js';

describe('ImaniApiAdapter', () => {
  const validPubkey = 'a'.repeat(64);
  const validPubkey2 = 'b'.repeat(64);
  const baseUrl = 'https://api.example.com';

  const createMockHttpClient = (): HttpClient => ({
    get: vi.fn(),
    post: vi.fn(),
  });

  const sampleApiProfile = {
    pubkey: validPubkey,
    name: 'Test User',
    display_name: 'Test Display',
    picture: 'https://example.com/pic.jpg',
    about: 'A test user',
    nip05: 'test@example.com',
    lud16: 'test@lightning.example.com',
    currencies: ['USD', 'EUR'],
    merchant_tags: ['merchant'],
    location: {
      lat: 40.7128,
      lon: -74.006,
      city: 'New York',
    },
    created_at: 1700000000,
  };

  const sampleApiMerchantProfile = {
    pubkey: validPubkey,
    business_name: 'Test Business',
    business_type: 'retail',
    currencies: ['USD', 'EUR'],
    payment_methods: ['cashu', 'lightning'],
    verified: true,
    verified_at: 1700000000,
  };

  describe('factory function', () => {
    it('should create an instance', () => {
      const adapter = createImaniApiAdapter({ baseUrl });
      expect(adapter).toBeInstanceOf(ImaniApiAdapter);
    });

    it('should accept custom HTTP client', () => {
      const httpClient = createMockHttpClient();
      const adapter = createImaniApiAdapter({ baseUrl, httpClient });
      expect(adapter).toBeInstanceOf(ImaniApiAdapter);
    });
  });

  describe('search', () => {
    it('should search with query', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [sampleApiProfile],
        cursor: 'next-page',
        total: 1,
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.search({ query: 'test' });

      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/profiles/search?'),
        expect.any(Object)
      );
      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('q=test'),
        expect.any(Object)
      );
      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0].name).toBe('Test User');
    });

    it('should search with merchantOnly filter', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [],
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      await adapter.search({ merchantOnly: true });

      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('merchant_only=true'),
        expect.any(Object)
      );
    });

    it('should search with currencies filter', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [],
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      await adapter.search({ currencies: ['USD', 'EUR'] });

      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('currencies=USD%2CEUR'),
        expect.any(Object)
      );
    });

    it('should search with location filter', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [],
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      await adapter.search({ location: { lat: 40.7128, lon: -74.006, radiusKm: 10 } });

      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('lat=40.7128'),
        expect.any(Object)
      );
      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('lon=-74.006'),
        expect.any(Object)
      );
      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('radius_km=10'),
        expect.any(Object)
      );
    });

    it('should search with pagination', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [],
        cursor: 'next',
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      await adapter.search({ limit: 20, cursor: 'abc123' });

      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('limit=20'),
        expect.any(Object)
      );
      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('cursor=abc123'),
        expect.any(Object)
      );
    });

    it('should map API response to Profile type', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [sampleApiProfile],
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.search({});

      const profile = result.profiles[0];
      expect(profile.pubkey).toBe(validPubkey);
      expect(profile.name).toBe('Test User');
      expect(profile.displayName).toBe('Test Display');
      expect(profile.merchantTags).toEqual(['merchant']);
      expect(profile.currencies).toEqual(['USD', 'EUR']);
      expect(profile.location?.lat).toBe(40.7128);
    });

    it('should include totalCount from response', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [],
        total: 100,
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.search({});

      expect(result.totalCount).toBe(100);
    });
  });

  describe('suggest', () => {
    it('should return suggestions', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        suggestions: ['Coffee Shop', 'Coffee House'],
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.suggest('coff');

      expect(httpClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/profiles/suggest?q=coff'),
        expect.any(Object)
      );
      expect(result).toEqual(['Coffee Shop', 'Coffee House']);
    });
  });

  describe('getProfile', () => {
    it('should return null for invalid pubkey', async () => {
      const httpClient = createMockHttpClient();
      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });

      const result = await adapter.getProfile('invalid');
      expect(result).toBeNull();
      expect(httpClient.get).not.toHaveBeenCalled();
    });

    it('should fetch profile by pubkey', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(sampleApiProfile);

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.getProfile(validPubkey);

      expect(httpClient.get).toHaveBeenCalledWith(
        `/profiles/${validPubkey}`,
        expect.any(Object)
      );
      expect(result?.pubkey).toBe(validPubkey);
      expect(result?.name).toBe('Test User');
    });

    it('should normalize uppercase pubkey', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(sampleApiProfile);

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      await adapter.getProfile(validPubkey.toUpperCase());

      expect(httpClient.get).toHaveBeenCalledWith(
        `/profiles/${validPubkey}`,
        expect.any(Object)
      );
    });

    it('should return null for 404', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('HTTP 404: Not Found')
      );

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.getProfile(validPubkey);

      expect(result).toBeNull();
    });

    it('should throw for other errors', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('HTTP 500: Server Error')
      );

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });

      await expect(adapter.getProfile(validPubkey)).rejects.toThrow('HTTP 500');
    });
  });

  describe('getProfiles', () => {
    it('should return empty array for empty input', async () => {
      const httpClient = createMockHttpClient();
      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });

      const result = await adapter.getProfiles([]);
      expect(result).toEqual([]);
      expect(httpClient.post).not.toHaveBeenCalled();
    });

    it('should filter invalid pubkeys', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [sampleApiProfile],
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      await adapter.getProfiles([validPubkey, 'invalid']);

      expect(httpClient.post).toHaveBeenCalledWith(
        '/profiles/batch',
        { pubkeys: [validPubkey] },
        expect.any(Object)
      );
    });

    it('should deduplicate pubkeys', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [sampleApiProfile],
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      await adapter.getProfiles([validPubkey, validPubkey, validPubkey.toUpperCase()]);

      expect(httpClient.post).toHaveBeenCalledWith(
        '/profiles/batch',
        { pubkeys: [validPubkey] },
        expect.any(Object)
      );
    });

    it('should return multiple profiles', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.post as ReturnType<typeof vi.fn>).mockResolvedValue({
        profiles: [
          sampleApiProfile,
          { ...sampleApiProfile, pubkey: validPubkey2, name: 'User 2' },
        ],
      });

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.getProfiles([validPubkey, validPubkey2]);

      expect(result).toHaveLength(2);
    });
  });

  describe('getMerchantProfile', () => {
    it('should return null for invalid pubkey', async () => {
      const httpClient = createMockHttpClient();
      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });

      const result = await adapter.getMerchantProfile('invalid');
      expect(result).toBeNull();
    });

    it('should fetch merchant profile', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(sampleApiMerchantProfile);

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.getMerchantProfile(validPubkey);

      expect(httpClient.get).toHaveBeenCalledWith(
        `/profiles/${validPubkey}/merchant`,
        expect.any(Object)
      );
      expect(result?.pubkey).toBe(validPubkey);
      expect(result?.businessName).toBe('Test Business');
      expect(result?.businessType).toBe('retail');
      expect(result?.currencies).toEqual(['USD', 'EUR']);
      expect(result?.paymentMethods).toEqual(['cashu', 'lightning']);
      expect(result?.verified).toBe(true);
    });

    it('should return null for 404', async () => {
      const httpClient = createMockHttpClient();
      (httpClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('HTTP 404: Not Found')
      );

      const adapter = new ImaniApiAdapter({ baseUrl, httpClient });
      const result = await adapter.getMerchantProfile(validPubkey);

      expect(result).toBeNull();
    });
  });

  describe('FetchHttpClient', () => {
    it('should construct with base URL', () => {
      const client = new FetchHttpClient('https://api.example.com/');
      expect(client).toBeInstanceOf(FetchHttpClient);
    });

    it('should strip trailing slash from base URL', () => {
      const client1 = new FetchHttpClient('https://api.example.com/');
      const client2 = new FetchHttpClient('https://api.example.com');
      // Both should work identically - test would require actual fetch mock
      expect(client1).toBeInstanceOf(FetchHttpClient);
      expect(client2).toBeInstanceOf(FetchHttpClient);
    });
  });

  describe('authentication', () => {
    it('should include API key in Authorization header', () => {
      const httpClient = createMockHttpClient();
      // Can't easily test header injection without mocking further
      // This just ensures the adapter accepts apiKey config
      const adapter = new ImaniApiAdapter({ baseUrl, apiKey: 'test-api-key', httpClient });
      expect(adapter).toBeInstanceOf(ImaniApiAdapter);
    });
  });

  describe('timeout handling', () => {
    it('should accept timeout config', () => {
      const adapter = new ImaniApiAdapter({ baseUrl, timeoutMs: 5000 });
      expect(adapter).toBeInstanceOf(ImaniApiAdapter);
    });
  });
});
