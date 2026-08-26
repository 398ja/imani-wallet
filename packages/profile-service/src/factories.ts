import { ProfileService, type ProfileServiceConfig } from './core/ProfileService.js';
import { MemoryCacheStore } from './cache/MemoryCacheStore.js';
import { IndexedDBCacheStore } from './cache/IndexedDBCacheStore.js';
import { NostrLookupAdapter, type NostrPool } from './adapters/NostrLookupAdapter.js';
import { NostrDirectoryAdapter } from './adapters/NostrDirectoryAdapter.js';
import { LocalFollowAdapter, MemoryFollowAdapter } from './adapters/LocalFollowAdapter.js';
import { NostrFollowAdapter, type NostrSigner, type NostrPublisher } from './adapters/NostrFollowAdapter.js';
import type { Profile } from './types/profile.js';
import type { CacheStore } from './types/cache.js';
import type { ProfileEventListener } from './types/events.js';

/**
 * Base factory configuration options
 */
export interface BaseFactoryConfig {
  /** Nostr relays to connect to */
  relays: string[];
  /** Nostr pool instance for relay communication */
  pool: NostrPool;
  /** Event listener for profile events */
  onEvent?: ProfileEventListener;
  /** Timeout for relay queries in ms (default: 5000) */
  relayTimeoutMs?: number;
  /** Timeout for NIP-05 resolution in ms (default: 5000) */
  nip05TimeoutMs?: number;
  /** Enable optimistic updates for follows (default: true) */
  optimisticUpdates?: boolean;
  /** Default search limit (default: 20) */
  defaultSearchLimit?: number;
}

/**
 * Browser-specific factory configuration
 */
export interface BrowserFactoryConfig extends BaseFactoryConfig {
  /** Database name for cache (default: 'profile-service-cache') */
  cacheDbName?: string;
  /** Cache TTL in ms (default: 5 minutes) */
  cacheTtlMs?: number;
  /** Max cache size (default: 1000) */
  cacheMaxSize?: number;
  /** Use IndexedDB for follows (default: true, false uses Nostr kind-3) */
  useLocalFollows?: boolean;
  /** Database name for follows (default: 'profile-service-follows') */
  followsDbName?: string;
  /** Nostr signer for publishing follow events (required if useLocalFollows is false) */
  signer?: NostrSigner;
  /** Nostr publisher for publishing follow events (required if useLocalFollows is false) */
  publisher?: NostrPublisher;
}

/**
 * Node-specific factory configuration
 */
export interface NodeFactoryConfig extends BaseFactoryConfig {
  /** External cache store (default: uses MemoryCacheStore) */
  cache?: CacheStore<Profile>;
  /** Cache max size (default: 1000, only for default MemoryCacheStore) */
  cacheMaxSize?: number;
  /** Cache TTL in ms (default: 5 minutes, only for default MemoryCacheStore) */
  cacheTtlMs?: number;
  /** Nostr signer for publishing follow events */
  signer?: NostrSigner;
  /** Nostr publisher for publishing follow events */
  publisher?: NostrPublisher;
}

/**
 * Create a ProfileService configured for browser environments
 *
 * Uses:
 * - IndexedDB for profile caching
 * - IndexedDB for follow list (optional Nostr kind-3)
 * - Nostr relays for profile lookup and directory
 *
 * @example
 * ```typescript
 * import { SimplePool } from 'nostr-tools';
 *
 * const pool = new SimplePool();
 * const service = createBrowserService({
 *   relays: ['wss://relay.imani.casa', 'wss://relay.imani.casa'],
 *   pool,
 *   onEvent: (event) => console.log('Event:', event),
 * });
 *
 * // Search for profiles
 * const result = await service.search({ query: 'bitcoin' });
 * ```
 */
export function createBrowserService(config: BrowserFactoryConfig): ProfileService {
  const {
    relays,
    pool,
    onEvent,
    relayTimeoutMs = 5000,
    nip05TimeoutMs = 5000,
    optimisticUpdates = true,
    defaultSearchLimit = 20,
    cacheDbName = 'profile-service-cache',
    cacheTtlMs = 5 * 60 * 1000,
    cacheMaxSize = 1000,
    useLocalFollows = true,
    followsDbName = 'profile-service-follows',
    signer,
    publisher,
  } = config;

  // Create IndexedDB cache
  const cache = new IndexedDBCacheStore<Profile>({
    name: cacheDbName,
    defaultTtlMs: cacheTtlMs,
    maxSize: cacheMaxSize,
  });

  // Create adapters
  const lookupAdapter = new NostrLookupAdapter({
    relays,
    pool,
    timeoutMs: relayTimeoutMs,
  });

  const directoryAdapter = new NostrDirectoryAdapter({
    relays,
    pool,
    timeoutMs: relayTimeoutMs,
  });

  // Create follow adapter
  let followAdapter;
  if (useLocalFollows) {
    followAdapter = new LocalFollowAdapter({
      dbName: followsDbName,
    });
  } else {
    if (!signer || !publisher) {
      throw new Error('signer and publisher are required when useLocalFollows is false');
    }
    followAdapter = new NostrFollowAdapter({
      relays,
      pool,
      signer,
      publisher,
      timeoutMs: relayTimeoutMs,
    });
  }

  const serviceConfig: ProfileServiceConfig = {
    directoryAdapter,
    lookupAdapter,
    followAdapter,
    cache,
    onEvent,
    nip05TimeoutMs,
    optimisticUpdates,
    defaultSearchLimit,
  };

  return new ProfileService(serviceConfig);
}

/**
 * Create a ProfileService configured for Node.js environments
 *
 * Uses:
 * - Memory cache for profile caching (or custom cache)
 * - Nostr kind-3 events for follow list (or in-memory for read-only)
 * - Nostr relays for profile lookup and directory
 *
 * @example
 * ```typescript
 * import { SimplePool } from 'nostr-tools';
 *
 * const pool = new SimplePool();
 * const service = createNodeService({
 *   relays: ['wss://relay.imani.casa', 'wss://relay.imani.casa'],
 *   pool,
 *   signer: myNip07Signer,
 *   publisher: myPublisher,
 * });
 *
 * // Get a profile
 * const profile = await service.getProfile('pubkey123...');
 * ```
 */
export function createNodeService(config: NodeFactoryConfig): ProfileService {
  const {
    relays,
    pool,
    onEvent,
    relayTimeoutMs = 5000,
    nip05TimeoutMs = 5000,
    optimisticUpdates = true,
    defaultSearchLimit = 20,
    cache: externalCache,
    cacheMaxSize = 1000,
    cacheTtlMs = 5 * 60 * 1000,
    signer,
    publisher,
  } = config;

  // Create memory cache if not provided
  const cache = externalCache ?? new MemoryCacheStore<Profile>({
    defaultTtlMs: cacheTtlMs,
    maxSize: cacheMaxSize,
  });

  // Create adapters
  const lookupAdapter = new NostrLookupAdapter({
    relays,
    pool,
    timeoutMs: relayTimeoutMs,
  });

  const directoryAdapter = new NostrDirectoryAdapter({
    relays,
    pool,
    timeoutMs: relayTimeoutMs,
  });

  // Create follow adapter
  let followAdapter;
  if (signer && publisher) {
    followAdapter = new NostrFollowAdapter({
      relays,
      pool,
      signer,
      publisher,
      timeoutMs: relayTimeoutMs,
    });
  } else {
    // Use in-memory follow adapter for read-only scenarios
    followAdapter = new MemoryFollowAdapter();
  }

  const serviceConfig: ProfileServiceConfig = {
    directoryAdapter,
    lookupAdapter,
    followAdapter,
    cache,
    onEvent,
    nip05TimeoutMs,
    optimisticUpdates,
    defaultSearchLimit,
  };

  return new ProfileService(serviceConfig);
}

/**
 * Create a minimal ProfileService for testing or simple use cases
 *
 * Uses in-memory storage for everything - no persistence.
 *
 * @example
 * ```typescript
 * import { SimplePool } from 'nostr-tools';
 *
 * const pool = new SimplePool();
 * const service = createMinimalService({
 *   relays: ['wss://relay.imani.casa'],
 *   pool,
 * });
 *
 * const profile = await service.getProfile('pubkey...');
 * ```
 */
export function createMinimalService(config: BaseFactoryConfig): ProfileService {
  const {
    relays,
    pool,
    onEvent,
    relayTimeoutMs = 5000,
    nip05TimeoutMs = 5000,
    optimisticUpdates = true,
    defaultSearchLimit = 20,
  } = config;

  const lookupAdapter = new NostrLookupAdapter({
    relays,
    pool,
    timeoutMs: relayTimeoutMs,
  });

  const directoryAdapter = new NostrDirectoryAdapter({
    relays,
    pool,
    timeoutMs: relayTimeoutMs,
  });

  const followAdapter = new MemoryFollowAdapter();

  const cache = new MemoryCacheStore<Profile>({
    maxSize: 100,
    defaultTtlMs: 5 * 60 * 1000,
  });

  return new ProfileService({
    directoryAdapter,
    lookupAdapter,
    followAdapter,
    cache,
    onEvent,
    nip05TimeoutMs,
    optimisticUpdates,
    defaultSearchLimit,
  });
}
