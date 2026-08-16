import type { SimplePool, Filter } from 'nostr-tools';
import type {
  Profile,
  MerchantProfile,
  CacheStore,
  LookupAdapter,
} from '../types/index.js';
import {
  networkError,
  relayTimeoutError,
} from '../types/errors.js';
import { normalizePubkey } from '../utils/validate.js';

/**
 * Configuration for ProfileLookup
 */
export interface ProfileLookupConfig {
  /** Relay URLs to query */
  relays: string[];
  /** nostr-tools SimplePool instance */
  pool: SimplePool;
  /** Memory cache for profiles (fast, short TTL) */
  memoryCache?: CacheStore<Profile>;
  /** Persistent cache for profiles (IndexedDB, longer TTL) */
  persistentCache?: CacheStore<Profile>;
  /** Merchant profile cache */
  merchantCache?: CacheStore<MerchantProfile>;
  /** Timeout for relay queries in ms */
  timeoutMs?: number;
  /** Enable stale-while-revalidate pattern */
  staleWhileRevalidate?: boolean;
}

/**
 * Nostr event kinds
 */
const KIND_PROFILE = 0;
const KIND_MERCHANT = 30078;

/**
 * Default timeout for relay queries
 */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Raw Nostr event structure
 */
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * ProfileLookup service for fetching profiles from Nostr relays
 * Implements multi-tier caching with stale-while-revalidate
 */
export class ProfileLookup implements LookupAdapter {
  private readonly relays: string[];
  private readonly pool: SimplePool;
  private readonly memoryCache?: CacheStore<Profile>;
  private readonly persistentCache?: CacheStore<Profile>;
  private readonly merchantCache?: CacheStore<MerchantProfile>;
  private readonly timeoutMs: number;
  private readonly staleWhileRevalidate: boolean;

  /** Pending requests for deduplication */
  private readonly pendingRequests = new Map<string, Promise<Profile | null>>();
  private readonly pendingBatchRequests = new Map<string, Promise<Profile[]>>();

  constructor(config: ProfileLookupConfig) {
    this.relays = config.relays;
    this.pool = config.pool;
    this.memoryCache = config.memoryCache;
    this.persistentCache = config.persistentCache;
    this.merchantCache = config.merchantCache;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.staleWhileRevalidate = config.staleWhileRevalidate ?? true;
  }

  /**
   * Get a single profile by pubkey
   */
  async getProfile(pubkey: string): Promise<Profile | null> {
    const normalizedPubkey = normalizePubkey(pubkey);
    const cacheKey = `profile:${normalizedPubkey}`;

    // Check memory cache first (fastest)
    if (this.memoryCache) {
      const cached = await this.memoryCache.get(cacheKey);
      if (cached) {
        // Optionally trigger background revalidation
        if (this.staleWhileRevalidate) {
          this.revalidateInBackground(normalizedPubkey, cacheKey);
        }
        return cached;
      }
    }

    // Check persistent cache (IndexedDB)
    if (this.persistentCache) {
      const cached = await this.persistentCache.get(cacheKey);
      if (cached) {
        // Hydrate memory cache
        if (this.memoryCache) {
          await this.memoryCache.set(cacheKey, cached);
        }
        // Optionally trigger background revalidation
        if (this.staleWhileRevalidate) {
          this.revalidateInBackground(normalizedPubkey, cacheKey);
        }
        return cached;
      }
    }

    // Deduplicate concurrent requests
    const pending = this.pendingRequests.get(normalizedPubkey);
    if (pending) {
      return pending;
    }

    // Fetch from relays
    const fetchPromise = this.fetchProfile(normalizedPubkey);
    this.pendingRequests.set(normalizedPubkey, fetchPromise);

    try {
      const profile = await fetchPromise;

      // Cache the result
      if (profile) {
        await this.cacheProfile(cacheKey, profile);
      }

      return profile;
    } finally {
      this.pendingRequests.delete(normalizedPubkey);
    }
  }

  /**
   * Get multiple profiles by pubkey (batch fetch)
   */
  async getProfiles(pubkeys: string[]): Promise<Profile[]> {
    if (pubkeys.length === 0) return [];

    const normalizedPubkeys = pubkeys.map(normalizePubkey);
    const results: Profile[] = [];
    const uncachedPubkeys: string[] = [];

    // Check caches first
    for (const pubkey of normalizedPubkeys) {
      const cacheKey = `profile:${pubkey}`;

      // Try memory cache
      if (this.memoryCache) {
        const cached = await this.memoryCache.get(cacheKey);
        if (cached) {
          results.push(cached);
          continue;
        }
      }

      // Try persistent cache
      if (this.persistentCache) {
        const cached = await this.persistentCache.get(cacheKey);
        if (cached) {
          results.push(cached);
          // Hydrate memory cache
          if (this.memoryCache) {
            await this.memoryCache.set(cacheKey, cached);
          }
          continue;
        }
      }

      uncachedPubkeys.push(pubkey);
    }

    // Batch fetch uncached profiles
    if (uncachedPubkeys.length > 0) {
      const fetched = await this.batchFetchProfiles(uncachedPubkeys);
      results.push(...fetched);
    }

    return results;
  }

  /**
   * Get merchant profile (kind-30078)
   */
  async getMerchantProfile(pubkey: string): Promise<MerchantProfile | null> {
    const normalizedPubkey = normalizePubkey(pubkey);
    const cacheKey = `merchant:${normalizedPubkey}`;

    // Check cache
    if (this.merchantCache) {
      const cached = await this.merchantCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Fetch from relays
    const merchantProfile = await this.fetchMerchantProfile(normalizedPubkey);

    // Cache the result
    if (merchantProfile && this.merchantCache) {
      await this.merchantCache.set(cacheKey, merchantProfile);
    }

    return merchantProfile;
  }

  /**
   * Fetch profile from relays
   */
  private async fetchProfile(pubkey: string): Promise<Profile | null> {
    const filter: Filter = {
      kinds: [KIND_PROFILE],
      authors: [pubkey],
      limit: 1,
    };

    try {
      const events = await this.queryRelaysWithTimeout(filter);

      if (!events.length) {
        return null;
      }

      // Get most recent event
      const latest = events.reduce((a, b) =>
        b.created_at > a.created_at ? b : a
      );

      return this.parseProfile(latest);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        throw relayTimeoutError(this.relays[0] || 'unknown');
      }
      throw networkError('Failed to fetch profile', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Batch fetch profiles from relays
   */
  private async batchFetchProfiles(pubkeys: string[]): Promise<Profile[]> {
    const batchKey = pubkeys.sort().join(',');

    // Deduplicate batch requests
    const pending = this.pendingBatchRequests.get(batchKey);
    if (pending) {
      return pending;
    }

    const filter: Filter = {
      kinds: [KIND_PROFILE],
      authors: pubkeys,
      limit: pubkeys.length,
    };

    const fetchPromise = (async () => {
      try {
        const events = await this.queryRelaysWithTimeout(filter);

        // Group by pubkey and get most recent for each
        const profileMap = new Map<string, NostrEvent>();
        for (const event of events) {
          const existing = profileMap.get(event.pubkey);
          if (!existing || event.created_at > existing.created_at) {
            profileMap.set(event.pubkey, event);
          }
        }

        const profiles: Profile[] = [];
        for (const [pubkey, event] of profileMap) {
          const profile = this.parseProfile(event);
          if (profile) {
            profiles.push(profile);
            // Cache each profile
            const cacheKey = `profile:${pubkey}`;
            await this.cacheProfile(cacheKey, profile);
          }
        }

        return profiles;
      } catch (error) {
        throw networkError('Failed to batch fetch profiles', error instanceof Error ? error : undefined);
      }
    })();

    this.pendingBatchRequests.set(batchKey, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.pendingBatchRequests.delete(batchKey);
    }
  }

  /**
   * Fetch merchant profile from relays
   */
  private async fetchMerchantProfile(pubkey: string): Promise<MerchantProfile | null> {
    const filter: Filter = {
      kinds: [KIND_MERCHANT],
      authors: [pubkey],
      '#d': ['merchant-profile'],
      limit: 1,
    };

    try {
      const events = await this.queryRelaysWithTimeout(filter);

      if (!events.length) {
        return null;
      }

      const latest = events.reduce((a, b) =>
        b.created_at > a.created_at ? b : a
      );

      return this.parseMerchantProfile(latest);
    } catch {
      return null;
    }
  }

  /**
   * Query relays with timeout
   */
  private async queryRelaysWithTimeout(filter: Filter): Promise<NostrEvent[]> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Relay query timeout'));
      }, this.timeoutMs);

      // Use querySync from nostr-tools SimplePool
      (this.pool as unknown as { querySync: (relays: string[], filter: Filter) => Promise<NostrEvent[]> })
        .querySync(this.relays, filter)
        .then((events) => {
          clearTimeout(timeoutId);
          resolve(events);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Parse kind-0 event into Profile
   */
  private parseProfile(event: NostrEvent): Profile | null {
    try {
      const metadata = JSON.parse(event.content) as Record<string, unknown>;

      return {
        pubkey: event.pubkey,
        name: metadata.name as string | undefined,
        displayName: metadata.display_name as string | undefined,
        picture: metadata.picture as string | undefined,
        banner: metadata.banner as string | undefined,
        about: metadata.about as string | undefined,
        nip05: metadata.nip05 as string | undefined,
        lud16: metadata.lud16 as string | undefined,
        lud06: metadata.lud06 as string | undefined,
        website: metadata.website as string | undefined,
        currencies: metadata.currencies as string[] | undefined,
        merchantTags: this.extractMerchantTags(metadata),
        location: this.extractLocation(metadata),
        metadata,
        createdAt: event.created_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse kind-30078 event into MerchantProfile
   */
  private parseMerchantProfile(event: NostrEvent): MerchantProfile | null {
    try {
      const metadata = JSON.parse(event.content) as Record<string, unknown>;

      return {
        pubkey: event.pubkey,
        businessName: metadata.business_name as string | undefined,
        businessType: metadata.business_type as string | undefined,
        currencies: (metadata.currencies as string[]) ?? [],
        paymentMethods: metadata.payment_methods as string[] | undefined,
        location: this.extractLocation(metadata),
        hours: metadata.hours as Record<string, string> | undefined,
        verified: metadata.verified as boolean | undefined,
        verifiedAt: metadata.verified_at as number | undefined,
        metadata,
        createdAt: event.created_at,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract merchant tags from metadata
   */
  private extractMerchantTags(metadata: Record<string, unknown>): string[] | undefined {
    const tags = metadata.merchant_tags ?? metadata.merchantTags;
    if (Array.isArray(tags)) {
      return tags.filter((t): t is string => typeof t === 'string');
    }
    return undefined;
  }

  /**
   * Extract location from metadata
   */
  private extractLocation(metadata: Record<string, unknown>): Profile['location'] | undefined {
    const location = metadata.location as Record<string, unknown> | undefined;
    if (!location) return undefined;

    const lat = location.lat as number | undefined;
    const lon = location.lon ?? location.lng as number | undefined;

    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return undefined;
    }

    return {
      lat,
      lon,
      address: location.address as string | undefined,
      country: location.country as string | undefined,
      city: location.city as string | undefined,
    };
  }

  /**
   * Cache profile in all cache tiers
   */
  private async cacheProfile(cacheKey: string, profile: Profile): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.memoryCache) {
      promises.push(this.memoryCache.set(cacheKey, profile));
    }
    if (this.persistentCache) {
      promises.push(this.persistentCache.set(cacheKey, profile));
    }

    await Promise.all(promises);
  }

  /**
   * Revalidate profile in background (SWR pattern)
   */
  private revalidateInBackground(pubkey: string, cacheKey: string): void {
    // Don't await - fire and forget
    this.fetchProfile(pubkey)
      .then(async (profile) => {
        if (profile) {
          await this.cacheProfile(cacheKey, profile);
        }
      })
      .catch(() => {
        // Silently ignore background revalidation errors
      });
  }

  /**
   * Clear all caches
   */
  async clearCaches(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.memoryCache) promises.push(this.memoryCache.clear());
    if (this.persistentCache) promises.push(this.persistentCache.clear());
    if (this.merchantCache) promises.push(this.merchantCache.clear());

    await Promise.all(promises);
  }

  /**
   * Clear pending requests
   */
  clearPending(): void {
    this.pendingRequests.clear();
    this.pendingBatchRequests.clear();
  }
}

/**
 * Create a ProfileLookup instance
 */
export function createProfileLookup(config: ProfileLookupConfig): ProfileLookup {
  return new ProfileLookup(config);
}
