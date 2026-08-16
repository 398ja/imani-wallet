import type {
  DirectoryAdapter,
  LookupAdapter,
  FollowAdapter,
  Profile,
  MerchantProfile,
  FullProfile,
  ProfileFilter,
  ProfileSearchResult,
  Nip05Result,
  CacheStore,
  ProfileEventListener,
  ProfileEventEmitter,
  AddFollowOptions,
  FollowList,
  FollowEntry,
} from '../types/index.js';
import { ProfileDirectory } from './ProfileDirectory.js';
import { FollowManager } from './FollowManager.js';
import {
  FollowSyncCoordinator,
  type RemoteFollowSource,
  type FollowLocalStore,
  type FollowSyncState,
} from './FollowSyncCoordinator.js';
import { Nip05Resolver } from './Nip05Resolver.js';
import { SimpleEventEmitter, createEventHelpers } from '../utils/eventEmitter.js';
import { isValidPubkey, isValidNip05 } from '../utils/validate.js';

/**
 * Configuration for ProfileService
 */
export interface ProfileServiceConfig {
  /** Directory adapter for searching profiles */
  directoryAdapter: DirectoryAdapter;
  /** Lookup adapter for fetching individual profiles */
  lookupAdapter: LookupAdapter;
  /** Follow adapter for managing follow list */
  followAdapter: FollowAdapter;
  /** Optional cache store for profiles */
  cache?: CacheStore<Profile>;
  /** Event listener for profile events */
  onEvent?: ProfileEventListener;
  /** Timeout for NIP-05 resolution in ms (default: 5000) */
  nip05TimeoutMs?: number;
  /** Enable optimistic updates for follows (default: true) */
  optimisticUpdates?: boolean;
  /** Default search limit (default: 20) */
  defaultSearchLimit?: number;
}

/**
 * ProfileService provides a unified high-level API for profile operations
 *
 * Combines directory search, profile lookup, NIP-05 resolution, and follow
 * management into a single cohesive interface with caching and events.
 */
export class ProfileService {
  private readonly directory: ProfileDirectory;
  private readonly lookupAdapter: LookupAdapter;
  private readonly followManager: FollowManager;
  private readonly followAdapter: FollowAdapter;
  private followSyncCoordinator: FollowSyncCoordinator | null = null;
  private readonly nip05Resolver: Nip05Resolver;
  private readonly eventEmitter: ProfileEventEmitter;
  private readonly eventHelpers: ReturnType<typeof createEventHelpers>;
  private readonly cache?: CacheStore<Profile>;
  private readonly defaultSearchLimit: number;

  constructor(config: ProfileServiceConfig) {
    this.eventEmitter = new SimpleEventEmitter();
    this.eventHelpers = createEventHelpers(this.eventEmitter);
    this.cache = config.cache;
    this.defaultSearchLimit = config.defaultSearchLimit ?? 20;
    this.lookupAdapter = config.lookupAdapter;

    // Register external event listener if provided
    if (config.onEvent) {
      this.eventEmitter.on(config.onEvent);
    }

    // Initialize directory
    this.directory = new ProfileDirectory({
      adapter: config.directoryAdapter,
      defaultLimit: this.defaultSearchLimit,
    });

    // Initialize follow manager
    this.followAdapter = config.followAdapter;
    this.followManager = new FollowManager({
      adapter: config.followAdapter,
      eventEmitter: this.eventEmitter,
      optimisticUpdates: config.optimisticUpdates ?? true,
    });

    // Initialize NIP-05 resolver
    this.nip05Resolver = new Nip05Resolver({
      timeoutMs: config.nip05TimeoutMs ?? 5000,
    });
  }

  // ==================== Search Operations ====================

  /**
   * Search for profiles matching the filter
   * @param filter - Search filter options
   */
  async search(filter?: ProfileFilter): Promise<ProfileSearchResult> {
    const searchFilter = {
      ...filter,
      limit: filter?.limit ?? this.defaultSearchLimit,
    };

    const startTime = Date.now();
    const result = await this.directory.search(searchFilter);
    const durationMs = Date.now() - startTime;

    this.eventHelpers.emitSearchExecuted(searchFilter, result.profiles.length, durationMs);

    return result;
  }

  /**
   * Get search suggestions for autocomplete
   * @param query - Partial query string
   */
  async suggest(query: string): Promise<string[]> {
    return this.directory.suggest(query);
  }

  /**
   * Search all profiles with pagination (async generator)
   * @param filter - Search filter options
   */
  async *searchAll(filter?: ProfileFilter): AsyncGenerator<Profile[], void, unknown> {
    yield* this.directory.searchAll(filter);
  }

  // ==================== Lookup Operations ====================

  /**
   * Look up a profile by pubkey or NIP-05 identifier
   * @param identifier - Hex pubkey, npub, or NIP-05 identifier
   */
  async lookupByIdentifier(identifier: string): Promise<Profile | null> {
    // Check if it's a NIP-05 identifier
    if (isValidNip05(identifier)) {
      const resolved = await this.resolveNip05(identifier);
      if (!resolved) return null;
      return this.getProfile(resolved.pubkey);
    }

    // Otherwise treat as pubkey
    return this.getProfile(identifier);
  }

  /**
   * Look up a profile by pubkey
   * @param pubkey - Hex pubkey
   */
  async getProfile(pubkey: string): Promise<Profile | null> {
    const cacheKey = `profile:${pubkey}`;

    // Check cache first
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        this.eventHelpers.emitCacheHit(cacheKey, 'memory');
        this.eventHelpers.emitProfileViewed(pubkey, cached);
        return cached;
      }
      this.eventHelpers.emitCacheMiss(cacheKey);
    }

    const profile = await this.lookupAdapter.getProfile(pubkey);
    if (profile) {
      // Cache the result
      if (this.cache) {
        await this.cache.set(cacheKey, profile);
      }
      this.eventHelpers.emitProfileViewed(pubkey, profile);
    }
    return profile;
  }

  /**
   * Look up multiple profiles by pubkey
   * @param pubkeys - Array of hex pubkeys
   */
  async getProfiles(pubkeys: string[]): Promise<Profile[]> {
    return this.lookupAdapter.getProfiles(pubkeys);
  }

  /**
   * Look up a merchant profile
   * @param pubkey - Hex pubkey
   */
  async getMerchantProfile(pubkey: string): Promise<MerchantProfile | null> {
    if (this.lookupAdapter.getMerchantProfile) {
      return this.lookupAdapter.getMerchantProfile(pubkey);
    }
    return null;
  }

  /**
   * Get full profile including merchant data
   * @param pubkey - Hex pubkey
   */
  async getFullProfile(pubkey: string): Promise<FullProfile | null> {
    const [profile, merchantProfile] = await Promise.all([
      this.getProfile(pubkey),
      this.getMerchantProfile(pubkey),
    ]);

    if (!profile) return null;

    return {
      profile,
      merchantProfile: merchantProfile ?? undefined,
    };
  }

  // ==================== NIP-05 Operations ====================

  /**
   * Resolve a NIP-05 identifier to pubkey
   * @param identifier - NIP-05 identifier (e.g., "user@domain.com")
   */
  async resolveNip05(identifier: string): Promise<Nip05Result | null> {
    return this.nip05Resolver.resolve(identifier);
  }

  /**
   * Resolve NIP-05 with caching
   * @param identifier - NIP-05 identifier
   */
  async resolveNip05Cached(identifier: string): Promise<Nip05Result | null> {
    return this.nip05Resolver.resolveWithCache(identifier);
  }

  // ==================== Follow Operations ====================

  /**
   * Follow a pubkey
   * @param pubkey - Hex pubkey to follow
   * @param options - Follow options (labels, source)
   */
  async follow(pubkey: string, options?: AddFollowOptions): Promise<void> {
    return this.followManager.follow(pubkey, options);
  }

  /**
   * Unfollow a pubkey
   * @param pubkey - Hex pubkey to unfollow
   */
  async unfollow(pubkey: string): Promise<void> {
    return this.followManager.unfollow(pubkey);
  }

  /**
   * Toggle follow status
   * @param pubkey - Hex pubkey
   * @param options - Follow options if following
   * @returns true if now following, false if unfollowed
   */
  async toggleFollow(pubkey: string, options?: AddFollowOptions): Promise<boolean> {
    return this.followManager.toggle(pubkey, options);
  }

  /**
   * Check if following a pubkey
   * @param pubkey - Hex pubkey
   */
  async isFollowing(pubkey: string): Promise<boolean> {
    return this.followManager.isFollowing(pubkey);
  }

  /**
   * Get list of followed pubkeys
   */
  async listFollows(): Promise<string[]> {
    return this.followManager.list();
  }

  /**
   * Get follow entries with metadata
   */
  async listFollowEntries(): Promise<FollowEntry[]> {
    return this.followManager.listEntries();
  }

  /**
   * Followed CUSTOMERS subset (spec 044) — `unknown` merchant status counts as
   * customer (fail-open); reads local store only, no network.
   */
  async listCustomers(): Promise<FollowEntry[]> {
    return this.followManager.listCustomers();
  }

  /**
   * Followed MERCHANTS subset (spec 044) — only confirmed merchants.
   */
  async listMerchants(): Promise<FollowEntry[]> {
    return this.followManager.listMerchants();
  }

  /**
   * Get a full follow entry, or null if not followed (spec 044).
   */
  async getFollowEntry(pubkey: string): Promise<FollowEntry | null> {
    return this.followManager.getEntry(pubkey);
  }

  /**
   * Set the merchant discriminator on a followed entry (spec 044).
   */
  async setFollowMerchant(pubkey: string, merchant: FollowEntry['merchant'], checkedAt?: number): Promise<void> {
    return this.followManager.setMerchant(pubkey, merchant, checkedAt);
  }

  /**
   * Persist a denormalized kind-0 profile snapshot on a followed entry (spec 044
   * #2) for instant, local-first rendering of the followed list.
   */
  async setFollowProfile(
    pubkey: string,
    snapshot: { displayName?: string | null; picture?: string | null; nip05?: string | null },
    updatedAt?: number
  ): Promise<void> {
    return this.followManager.setProfile(pubkey, snapshot, updatedAt);
  }

  /**
   * Start background follow sync (spec 044). The host supplies the relay-backed
   * `RemoteFollowSource`; the coordinator reconciles it with the local store and
   * invalidates the manager cache on change so subset reads stay current. The
   * host owns the trigger cadence (visibility / online / periodic) and calls
   * `syncFollowsNow()`; this kicks the initial hydrate. Returns the sync state.
   */
  async startFollowSync(remote: RemoteFollowSource, opts: { onChange?: () => void } = {}): Promise<FollowSyncState> {
    if (!this.followSyncCoordinator) {
      const adapter = this.followAdapter;
      const store: FollowLocalStore = {
        // Never silently fall back to [] — that would blind the coordinator to
        // local pending changes (so it might never publish them) and misreport
        // pendingCount. Prefer listEntries; otherwise shim from list()+getEntry()
        // so we always see real local state, incl. syncState; else fail fast.
        listEntries: async (): Promise<FollowEntry[]> => {
          if (adapter.listEntries) return adapter.listEntries();
          if (adapter.getEntry) {
            const getEntry = adapter.getEntry.bind(adapter);
            const pubkeys = await adapter.list();
            const entries = await Promise.all(pubkeys.map((pk) => getEntry(pk)));
            return entries.filter((e): e is FollowEntry => e != null);
          }
          throw new Error(
            'FollowAdapter cannot enumerate entries: follow sync requires listEntries or getEntry'
          );
        },
        add: (pubkey, o) => adapter.add(pubkey, o),
        remove: (pubkey) => adapter.remove(pubkey),
      };
      this.followSyncCoordinator = new FollowSyncCoordinator({
        store,
        remote,
        onChange: () => {
          this.followManager.invalidate();
          opts.onChange?.();
        },
      });
    }
    return this.followSyncCoordinator.syncNow();
  }

  /** Force one reconcile pass, or null if sync hasn't been started (spec 044). */
  async syncFollowsNow(): Promise<FollowSyncState | null> {
    return this.followSyncCoordinator ? this.followSyncCoordinator.syncNow() : null;
  }

  /** Current sync state, or null if sync hasn't been started (spec 044). */
  getFollowSyncState(): FollowSyncState | null {
    return this.followSyncCoordinator ? this.followSyncCoordinator.getState() : null;
  }

  /**
   * Stop background follow sync (spec 044). Drops the coordinator so no further
   * syncs run; does NOT delete the durable local follow cache (FR-020 — ordinary
   * logout preserves the same user's offline follows).
   */
  stopFollowSync(): void {
    this.followSyncCoordinator = null;
  }

  /**
   * Get full follow list with sync status
   */
  async getFollowList(): Promise<FollowList> {
    return this.followManager.getFollowList();
  }

  /**
   * Get follows by label
   * @param label - Label to filter by
   */
  async getFollowsByLabel(label: string): Promise<FollowEntry[]> {
    return this.followManager.getByLabel(label);
  }

  /**
   * Add labels to a followed pubkey
   * @param pubkey - Hex pubkey
   * @param labels - Labels to add
   */
  async addFollowLabels(pubkey: string, labels: string[]): Promise<void> {
    return this.followManager.addLabels(pubkey, labels);
  }

  /**
   * Remove labels from a followed pubkey
   * @param pubkey - Hex pubkey
   * @param labels - Labels to remove
   */
  async removeFollowLabels(pubkey: string, labels: string[]): Promise<void> {
    return this.followManager.removeLabels(pubkey, labels);
  }

  // ==================== Profile Operations with Follow Status ====================

  /**
   * Get profiles with follow status
   * @param pubkeys - Array of hex pubkeys
   */
  async getProfilesWithFollowStatus(
    pubkeys: string[]
  ): Promise<Array<{ profile: Profile; isFollowing: boolean }>> {
    const [profiles, followList] = await Promise.all([
      this.getProfiles(pubkeys),
      this.listFollows(),
    ]);

    const followSet = new Set(followList);

    return profiles.map((profile) => ({
      profile,
      isFollowing: followSet.has(profile.pubkey),
    }));
  }

  /**
   * Get followed profiles
   */
  async getFollowedProfiles(): Promise<Profile[]> {
    const follows = await this.listFollows();
    return this.getProfiles(follows);
  }

  // ==================== Event Subscription ====================

  /**
   * Subscribe to profile events
   * @param listener - Event listener function
   * @returns Unsubscribe function
   */
  on(listener: ProfileEventListener): () => void {
    return this.eventEmitter.on(listener);
  }

  // ==================== Cache Operations ====================

  /**
   * Clear the profile cache
   */
  async clearCache(): Promise<void> {
    if (this.cache) {
      await this.cache.clear();
    }
  }

  // ==================== Utility ====================

  /**
   * Check if an identifier is valid (pubkey or NIP-05)
   * @param identifier - String to validate
   */
  isValidIdentifier(identifier: string): boolean {
    return isValidPubkey(identifier) || isValidNip05(identifier);
  }
}

/**
 * Create a ProfileService instance
 */
export function createProfileService(config: ProfileServiceConfig): ProfileService {
  return new ProfileService(config);
}
