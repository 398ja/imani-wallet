/**
 * Recipient Module Tests
 *
 * Tests for Nip05Resolver, RelayDiscovery, ProfileFetcher, and RecipientResolver.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Nip05Resolver,
  createNip05Resolver,
  RelayDiscovery,
  createRelayDiscovery,
  ProfileFetcher,
  createProfileFetcher,
  RecipientResolver,
  createRecipientResolver,
} from '../src/recipient';
import type { ApiAdapter, NostrAdapter } from '../src/adapters';
import type { NostrProfile, Nip05Result } from '../src/types';

// ============================================================================
// Test Fixtures
// ============================================================================

function createNostrAdapter(overrides: Partial<NostrAdapter> = {}): NostrAdapter {
  return {
    queryRelayList: vi.fn().mockResolvedValue(['wss://relay1.example.com', 'wss://relay2.example.com']),
    fetchNip05: vi.fn().mockResolvedValue({
      success: true,
      pubkey: 'abc123'.repeat(10) + 'abcd',
      relays: ['wss://nip05relay.example.com'],
    } as Nip05Result),
    publishProofs: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createApiAdapter(overrides: Partial<ApiAdapter> = {}): ApiAdapter {
  return {
    splitPreview: vi.fn(),
    splitExecute: vi.fn(),
    sendTokenDm: vi.fn(),
    getProfile: vi.fn().mockResolvedValue({
      name: 'Test User',
      picture: 'https://example.com/avatar.png',
      nip05: 'test@example.com',
    } as NostrProfile),
    ...overrides,
  };
}

function createMockFetch(response: unknown, options: { ok?: boolean; status?: number } = {}) {
  return vi.fn().mockResolvedValue({
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: () => Promise.resolve(response),
  });
}

// ============================================================================
// Nip05Resolver Tests
// ============================================================================

describe('Nip05Resolver', () => {
  describe('constructor', () => {
    it('creates with default config', () => {
      const resolver = new Nip05Resolver();
      expect(resolver).toBeInstanceOf(Nip05Resolver);
    });

    it('creates with nostr adapter', () => {
      const nostr = createNostrAdapter();
      const resolver = new Nip05Resolver(nostr);
      expect(resolver).toBeInstanceOf(Nip05Resolver);
    });
  });

  describe('createNip05Resolver', () => {
    it('creates resolver instance', () => {
      const resolver = createNip05Resolver();
      expect(resolver).toBeInstanceOf(Nip05Resolver);
    });
  });

  describe('normalize()', () => {
    it('adds default domain to bare username', () => {
      const resolver = new Nip05Resolver();
      expect(resolver.normalize('alice')).toBe('alice@imani.casa');
    });

    it('preserves full NIP-05 identifiers', () => {
      const resolver = new Nip05Resolver();
      expect(resolver.normalize('bob@other.com')).toBe('bob@other.com');
    });

    it('converts to lowercase', () => {
      const resolver = new Nip05Resolver();
      expect(resolver.normalize('Alice@Example.Com')).toBe('alice@example.com');
    });

    it('trims whitespace', () => {
      const resolver = new Nip05Resolver();
      expect(resolver.normalize('  alice@example.com  ')).toBe('alice@example.com');
    });

    it('uses custom default domain', () => {
      const resolver = new Nip05Resolver(undefined, { defaultDomain: 'custom.io' });
      expect(resolver.normalize('alice')).toBe('alice@custom.io');
    });
  });

  describe('isValid()', () => {
    let resolver: Nip05Resolver;

    beforeEach(() => {
      resolver = new Nip05Resolver();
    });

    it('validates correct NIP-05 format', () => {
      expect(resolver.isValid('alice@example.com')).toBe(true);
      expect(resolver.isValid('bob_123@test.io')).toBe(true);
      expect(resolver.isValid('user-name@domain.co.uk')).toBe(true);
    });

    it('validates bare username (with default domain)', () => {
      expect(resolver.isValid('alice')).toBe(true);
    });

    it('rejects invalid formats', () => {
      expect(resolver.isValid('@example.com')).toBe(false);
      expect(resolver.isValid('alice@')).toBe(false);
      expect(resolver.isValid('')).toBe(false);
    });
  });

  describe('parse()', () => {
    it('parses NIP-05 into username and domain', () => {
      const resolver = new Nip05Resolver();
      const result = resolver.parse('alice@example.com');
      expect(result.username).toBe('alice');
      expect(result.domain).toBe('example.com');
    });

    it('parses bare username with default domain', () => {
      const resolver = new Nip05Resolver();
      const result = resolver.parse('alice');
      expect(result.username).toBe('alice');
      expect(result.domain).toBe('imani.casa');
    });
  });

  describe('resolve()', () => {
    it('uses NostrAdapter when available', async () => {
      const nostr = createNostrAdapter();
      const resolver = new Nip05Resolver(nostr);

      const result = await resolver.resolve('alice@example.com');

      expect(nostr.fetchNip05).toHaveBeenCalledWith('alice@example.com');
      expect(result.success).toBe(true);
    });

    it('returns error for invalid format', async () => {
      const resolver = new Nip05Resolver();

      const result = await resolver.resolve('@invalid');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid NIP-05 format');
    });

    it('fetches directly without adapter', async () => {
      const mockFetch = createMockFetch({
        names: { alice: 'abc123'.repeat(10) + 'abcd' },
        relays: { ['abc123'.repeat(10) + 'abcd']: ['wss://relay.example.com'] },
      });
      const resolver = new Nip05Resolver(undefined, { fetchFn: mockFetch });

      const result = await resolver.resolve('alice@example.com');

      expect(mockFetch).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.pubkey).toBe('abc123'.repeat(10) + 'abcd');
    });

    it('handles HTTP errors', async () => {
      const mockFetch = createMockFetch({}, { ok: false, status: 404 });
      const resolver = new Nip05Resolver(undefined, { fetchFn: mockFetch });

      const result = await resolver.resolve('alice@example.com');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('handles user not in nostr.json', async () => {
      const mockFetch = createMockFetch({ names: {} });
      const resolver = new Nip05Resolver(undefined, { fetchFn: mockFetch });

      const result = await resolver.resolve('alice@example.com');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('handles network errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      const resolver = new Nip05Resolver(undefined, { fetchFn: mockFetch });

      const result = await resolver.resolve('alice@example.com');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });
  });

  describe('resolveOrThrow()', () => {
    it('returns pubkey and relays on success', async () => {
      const nostr = createNostrAdapter();
      const resolver = new Nip05Resolver(nostr);

      const result = await resolver.resolveOrThrow('alice@example.com');

      expect(result.pubkey).toBeDefined();
      expect(result.relays).toBeInstanceOf(Array);
    });

    it('throws on failure', async () => {
      const nostr = createNostrAdapter({
        fetchNip05: vi.fn().mockResolvedValue({ success: false, error: 'Not found' }),
      });
      const resolver = new Nip05Resolver(nostr);

      await expect(resolver.resolveOrThrow('unknown@example.com')).rejects.toThrow();
    });
  });
});

// ============================================================================
// RelayDiscovery Tests
// ============================================================================

describe('RelayDiscovery', () => {
  describe('constructor', () => {
    it('creates with default config', () => {
      const discovery = new RelayDiscovery();
      expect(discovery).toBeInstanceOf(RelayDiscovery);
    });

    it('creates with nostr adapter', () => {
      const nostr = createNostrAdapter();
      const discovery = new RelayDiscovery(nostr);
      expect(discovery).toBeInstanceOf(RelayDiscovery);
    });
  });

  describe('createRelayDiscovery', () => {
    it('creates discovery instance', () => {
      const discovery = createRelayDiscovery();
      expect(discovery).toBeInstanceOf(RelayDiscovery);
    });
  });

  describe('getRelays()', () => {
    it('returns NIP-65 relays from adapter', async () => {
      const nostr = createNostrAdapter();
      const discovery = new RelayDiscovery(nostr);

      const relays = await discovery.getRelays('pubkey123');

      expect(nostr.queryRelayList).toHaveBeenCalledWith('pubkey123');
      expect(relays).toContain('wss://relay1.example.com');
    });

    it('includes infrastructure relay first', async () => {
      const nostr = createNostrAdapter();
      const discovery = new RelayDiscovery(nostr, {
        infraRelay: 'wss://infra.relay.com',
      });

      const relays = await discovery.getRelays('pubkey123');

      expect(relays[0]).toBe('wss://infra.relay.com');
    });

    it('adds default relays when needed', async () => {
      const nostr = createNostrAdapter({
        queryRelayList: vi.fn().mockResolvedValue([]),
      });
      const discovery = new RelayDiscovery(nostr, {
        defaultRelays: ['wss://default.relay.com'],
      });

      const relays = await discovery.getRelays('pubkey123');

      expect(relays).toContain('wss://default.relay.com');
    });

    it('caches results', async () => {
      const nostr = createNostrAdapter();
      const discovery = new RelayDiscovery(nostr);

      await discovery.getRelays('pubkey123');
      await discovery.getRelays('pubkey123');

      expect(nostr.queryRelayList).toHaveBeenCalledTimes(1);
    });

    it('handles adapter errors gracefully', async () => {
      const nostr = createNostrAdapter({
        queryRelayList: vi.fn().mockRejectedValue(new Error('Network error')),
      });
      const discovery = new RelayDiscovery(nostr, {
        defaultRelays: ['wss://fallback.relay.com'],
      });

      const relays = await discovery.getRelays('pubkey123');

      expect(relays).toContain('wss://fallback.relay.com');
    });

    it('limits number of relays', async () => {
      const nostr = createNostrAdapter({
        queryRelayList: vi.fn().mockResolvedValue([
          'wss://r1.com', 'wss://r2.com', 'wss://r3.com',
          'wss://r4.com', 'wss://r5.com', 'wss://r6.com',
        ]),
      });
      const discovery = new RelayDiscovery(nostr, { maxRelays: 3 });

      const relays = await discovery.getRelays('pubkey123');

      expect(relays.length).toBeLessThanOrEqual(3);
    });
  });

  describe('buildRelayList()', () => {
    it('combines infra, custom, and NIP-65 relays', async () => {
      const nostr = createNostrAdapter();
      const discovery = new RelayDiscovery(nostr, {
        infraRelay: 'wss://infra.relay.com',
      });

      const relays = await discovery.buildRelayList('pubkey123', ['wss://custom.relay.com']);

      expect(relays).toContain('wss://infra.relay.com');
      expect(relays).toContain('wss://custom.relay.com');
      expect(relays).toContain('wss://relay1.example.com');
    });
  });

  describe('clearCache()', () => {
    it('clears cached relays', async () => {
      const nostr = createNostrAdapter();
      const discovery = new RelayDiscovery(nostr);

      await discovery.getRelays('pubkey123');
      discovery.clearCache();
      await discovery.getRelays('pubkey123');

      expect(nostr.queryRelayList).toHaveBeenCalledTimes(2);
    });
  });
});

// ============================================================================
// ProfileFetcher Tests
// ============================================================================

describe('ProfileFetcher', () => {
  describe('constructor', () => {
    it('creates with default config', () => {
      const fetcher = new ProfileFetcher();
      expect(fetcher).toBeInstanceOf(ProfileFetcher);
    });

    it('creates with API adapter', () => {
      const api = createApiAdapter();
      const fetcher = new ProfileFetcher(api);
      expect(fetcher).toBeInstanceOf(ProfileFetcher);
    });
  });

  describe('createProfileFetcher', () => {
    it('creates fetcher instance', () => {
      const fetcher = createProfileFetcher();
      expect(fetcher).toBeInstanceOf(ProfileFetcher);
    });
  });

  describe('fetch()', () => {
    it('returns profile data from API', async () => {
      const api = createApiAdapter();
      const fetcher = new ProfileFetcher(api);

      const result = await fetcher.fetch('pubkey123');

      expect(api.getProfile).toHaveBeenCalledWith('pubkey123');
      expect(result.success).toBe(true);
      expect(result.displayName).toBe('Test User');
      expect(result.picture).toBe('https://example.com/avatar.png');
    });

    it('returns error without API adapter', async () => {
      const fetcher = new ProfileFetcher();

      const result = await fetcher.fetch('pubkey123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No API adapter');
    });

    it('handles null profile', async () => {
      const api = createApiAdapter({
        getProfile: vi.fn().mockResolvedValue(null),
      });
      const fetcher = new ProfileFetcher(api);

      const result = await fetcher.fetch('pubkey123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('handles API errors', async () => {
      const api = createApiAdapter({
        getProfile: vi.fn().mockRejectedValue(new Error('API error')),
      });
      const fetcher = new ProfileFetcher(api);

      const result = await fetcher.fetch('pubkey123');

      expect(result.success).toBe(false);
      expect(result.error).toContain('API error');
    });

    it('caches successful results', async () => {
      const api = createApiAdapter();
      const fetcher = new ProfileFetcher(api);

      await fetcher.fetch('pubkey123');
      await fetcher.fetch('pubkey123');

      expect(api.getProfile).toHaveBeenCalledTimes(1);
    });

    it('extracts display_name over name', async () => {
      const api = createApiAdapter({
        getProfile: vi.fn().mockResolvedValue({
          display_name: 'Display Name',
          name: 'username',
        }),
      });
      const fetcher = new ProfileFetcher(api);

      const result = await fetcher.fetch('pubkey123');

      expect(result.displayName).toBe('Display Name');
    });
  });

  describe('getDisplayName()', () => {
    it('returns display name from profile', async () => {
      const api = createApiAdapter();
      const fetcher = new ProfileFetcher(api);

      const name = await fetcher.getDisplayName('pubkey123');

      expect(name).toBe('Test User');
    });

    it('returns fallback when no profile', async () => {
      const api = createApiAdapter({
        getProfile: vi.fn().mockResolvedValue(null),
      });
      const fetcher = new ProfileFetcher(api);

      const name = await fetcher.getDisplayName('pubkey123', 'Fallback');

      expect(name).toBe('Fallback');
    });

    it('returns truncated pubkey as last resort', async () => {
      const api = createApiAdapter({
        getProfile: vi.fn().mockResolvedValue(null),
      });
      const fetcher = new ProfileFetcher(api);
      const longPubkey = 'a'.repeat(64);

      const name = await fetcher.getDisplayName(longPubkey);

      expect(name).toContain('...');
      expect(name.length).toBeLessThan(64);
    });
  });
});

// ============================================================================
// RecipientResolver Tests
// ============================================================================

describe('RecipientResolver', () => {
  describe('constructor', () => {
    it('creates with default config', () => {
      const resolver = new RecipientResolver();
      expect(resolver).toBeInstanceOf(RecipientResolver);
    });

    it('creates with adapters', () => {
      const api = createApiAdapter();
      const nostr = createNostrAdapter();
      const resolver = new RecipientResolver(api, nostr);
      expect(resolver).toBeInstanceOf(RecipientResolver);
    });
  });

  describe('createRecipientResolver', () => {
    it('creates resolver instance', () => {
      const resolver = createRecipientResolver();
      expect(resolver).toBeInstanceOf(RecipientResolver);
    });
  });

  describe('resolve()', () => {
    it('passes through Recipient objects', async () => {
      const resolver = new RecipientResolver();
      const recipient = {
        npub: 'npub1test...',
        pubkeyHex: 'abc123'.repeat(10) + 'abcd',
        relays: ['wss://relay.example.com'],
      };

      const result = await resolver.resolve(recipient, { fetchProfile: false, fetchRelays: false });

      expect(result.pubkeyHex).toBe(recipient.pubkeyHex);
    });

    it('resolves hex pubkey', async () => {
      const api = createApiAdapter();
      const nostr = createNostrAdapter();
      const resolver = new RecipientResolver(api, nostr);
      const hexPubkey = 'abc123'.repeat(10) + 'abcd';

      const result = await resolver.resolve(hexPubkey);

      expect(result.pubkeyHex).toBe(hexPubkey);
    });

    it('resolves NIP-05 identifier', async () => {
      const api = createApiAdapter();
      const nostr = createNostrAdapter();
      const resolver = new RecipientResolver(api, nostr);

      const result = await resolver.resolve('alice@example.com');

      expect(result.nip05).toBe('alice@example.com');
      expect(result.pubkeyHex).toBeDefined();
    });

    it('resolves bare username with default domain', async () => {
      const api = createApiAdapter();
      const nostr = createNostrAdapter();
      const resolver = new RecipientResolver(api, nostr);

      const result = await resolver.resolve('alice');

      expect(result.nip05).toBe('alice@imani.casa');
    });

    it('fetches profile when enabled', async () => {
      const api = createApiAdapter();
      const nostr = createNostrAdapter();
      const resolver = new RecipientResolver(api, nostr);
      const hexPubkey = 'abc123'.repeat(10) + 'abcd';

      const result = await resolver.resolve(hexPubkey, { fetchProfile: true });

      expect(api.getProfile).toHaveBeenCalled();
      expect(result.displayName).toBeDefined();
    });

    it('fetches relays when enabled', async () => {
      const api = createApiAdapter();
      const nostr = createNostrAdapter();
      const resolver = new RecipientResolver(api, nostr);
      const hexPubkey = 'abc123'.repeat(10) + 'abcd';

      const result = await resolver.resolve(hexPubkey, { fetchRelays: true });

      expect(nostr.queryRelayList).toHaveBeenCalled();
      expect(result.relays.length).toBeGreaterThan(0);
    });

    it('skips profile fetch when disabled', async () => {
      const api = createApiAdapter();
      const nostr = createNostrAdapter();
      const resolver = new RecipientResolver(api, nostr, { fetchProfile: false });
      const hexPubkey = 'abc123'.repeat(10) + 'abcd';

      await resolver.resolve(hexPubkey);

      expect(api.getProfile).not.toHaveBeenCalled();
    });
  });

  describe('validate()', () => {
    let resolver: RecipientResolver;

    beforeEach(() => {
      resolver = new RecipientResolver();
    });

    it('validates valid recipient', () => {
      const recipient = {
        npub: 'npub1test',
        pubkeyHex: 'abc123'.repeat(10) + 'abcd',
        relays: [],
      };

      const result = resolver.validate(recipient);

      expect(result.valid).toBe(true);
    });

    it('rejects missing pubkey', () => {
      const recipient = {
        npub: 'npub1test',
        pubkeyHex: '',
        relays: [],
      };

      const result = resolver.validate(recipient);

      expect(result.valid).toBe(false);
    });

    it('rejects invalid pubkey format', () => {
      const recipient = {
        npub: 'npub1test',
        pubkeyHex: 'invalid',
        relays: [],
      };

      const result = resolver.validate(recipient);

      expect(result.valid).toBe(false);
    });
  });

  describe('isValidInput()', () => {
    let resolver: RecipientResolver;

    beforeEach(() => {
      resolver = new RecipientResolver();
    });

    it('validates hex pubkey', () => {
      expect(resolver.isValidInput('abc123'.repeat(10) + 'abcd')).toBe(true);
    });

    it('validates npub', () => {
      expect(resolver.isValidInput('npub1' + 'a'.repeat(58))).toBe(true);
    });

    it('validates NIP-05', () => {
      expect(resolver.isValidInput('alice@example.com')).toBe(true);
    });

    it('validates bare username', () => {
      expect(resolver.isValidInput('alice')).toBe(true);
    });
  });

  describe('getters', () => {
    it('exposes Nip05Resolver', () => {
      const resolver = new RecipientResolver();
      expect(resolver.getNip05Resolver()).toBeInstanceOf(Nip05Resolver);
    });

    it('exposes RelayDiscovery', () => {
      const resolver = new RecipientResolver();
      expect(resolver.getRelayDiscovery()).toBeInstanceOf(RelayDiscovery);
    });

    it('exposes ProfileFetcher', () => {
      const resolver = new RecipientResolver();
      expect(resolver.getProfileFetcher()).toBeInstanceOf(ProfileFetcher);
    });
  });

  describe('clearCaches()', () => {
    it('clears all caches', async () => {
      const api = createApiAdapter();
      const nostr = createNostrAdapter();
      const resolver = new RecipientResolver(api, nostr);
      const hexPubkey = 'abc123'.repeat(10) + 'abcd';

      // Populate caches
      await resolver.resolve(hexPubkey);

      // Clear caches
      resolver.clearCaches();

      // Fetch again - should hit adapters
      await resolver.resolve(hexPubkey);

      expect(api.getProfile).toHaveBeenCalledTimes(2);
      expect(nostr.queryRelayList).toHaveBeenCalledTimes(2);
    });
  });
});
