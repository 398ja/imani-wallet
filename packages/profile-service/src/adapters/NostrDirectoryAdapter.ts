import type { DirectoryAdapter } from '../types/adapters.js';
import type { Profile } from '../types/profile.js';
import type { ProfileFilter, ProfileSearchResult } from '../types/filters.js';
import type { NostrPool, NostrFilter, NostrEvent } from './NostrLookupAdapter.js';
import { filterProfiles, paginateResults, parseCursor, createCursor } from '../filters/FilterEngine.js';
import { scoreAndSort } from '../filters/Scoring.js';

/**
 * Configuration for NostrDirectoryAdapter
 */
export interface NostrDirectoryAdapterConfig {
  /** Nostr relays to query */
  relays: string[];
  /** Pool instance for relay communication */
  pool: NostrPool;
  /** Maximum profiles to fetch from relays (default: 500) */
  maxFetch?: number;
  /** Timeout for relay queries in ms (default: 10000) */
  timeoutMs?: number;
  /** Cache profiles locally (default: true) */
  enableCache?: boolean;
  /** Cache TTL in ms (default: 5 minutes) */
  cacheTtlMs?: number;
}

/** Nostr kind for profile metadata */
const KIND_METADATA = 0;

/**
 * NostrDirectoryAdapter provides profile search via Nostr relays
 *
 * Note: Nostr relays have limited search capabilities. This adapter
 * fetches recent profiles from relays and applies client-side filtering.
 * For better search performance, use an API-based adapter.
 */
export class NostrDirectoryAdapter implements DirectoryAdapter {
  private readonly relays: string[];
  private readonly pool: NostrPool;
  private readonly maxFetch: number;
  private readonly timeoutMs: number;
  private readonly enableCache: boolean;
  private readonly cacheTtlMs: number;

  /** Cached profiles from relays */
  private profileCache: Map<string, Profile> = new Map();
  /** Last cache refresh timestamp */
  private lastCacheRefresh = 0;

  constructor(config: NostrDirectoryAdapterConfig) {
    this.relays = config.relays;
    this.pool = config.pool;
    this.maxFetch = config.maxFetch ?? 500;
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.enableCache = config.enableCache ?? true;
    this.cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000;
  }

  /**
   * Search for profiles matching the filter
   *
   * Fetches profiles from relays and applies client-side filtering
   */
  async search(filter: ProfileFilter): Promise<ProfileSearchResult> {
    // Get all profiles (from cache or fetch)
    const allProfiles = await this.getAllProfiles();

    // Apply filters
    let filtered = filterProfiles(allProfiles, filter);

    // Apply scoring and sorting if query is present
    if (filter.query) {
      filtered = scoreAndSort(filtered, filter);
    }

    // Parse cursor for pagination
    const offset = filter.cursor ? parseCursor(filter.cursor) : 0;
    const limit = filter.limit ?? 20;

    // Paginate results
    const { items, hasMore, nextOffset } = paginateResults(filtered, limit, offset);

    return {
      profiles: items,
      cursor: hasMore && nextOffset !== undefined ? createCursor(nextOffset) : undefined,
      totalCount: filtered.length,
    };
  }

  /**
   * Get search suggestions (not supported by Nostr relays)
   */
  async suggest(query: string): Promise<string[]> {
    // Fetch profiles and extract unique names/display names matching query
    const allProfiles = await this.getAllProfiles();
    const suggestions = new Set<string>();

    const lowerQuery = query.toLowerCase();

    for (const profile of allProfiles) {
      if (profile.name && profile.name.toLowerCase().includes(lowerQuery)) {
        suggestions.add(profile.name);
      }
      if (profile.displayName && profile.displayName.toLowerCase().includes(lowerQuery)) {
        suggestions.add(profile.displayName);
      }
      if (suggestions.size >= 10) break;
    }

    return Array.from(suggestions);
  }

  /**
   * Refresh the profile cache
   */
  async refresh(): Promise<void> {
    await this.fetchProfiles();
  }

  /**
   * Clear the profile cache
   */
  clearCache(): void {
    this.profileCache.clear();
    this.lastCacheRefresh = 0;
  }

  /**
   * Close the pool connection
   */
  close(): void {
    if (this.pool.close) {
      this.pool.close(this.relays);
    }
    this.clearCache();
  }

  /**
   * Get all profiles (from cache or fetch)
   */
  private async getAllProfiles(): Promise<Profile[]> {
    const now = Date.now();

    // Check if cache is valid
    if (
      this.enableCache &&
      this.profileCache.size > 0 &&
      now - this.lastCacheRefresh < this.cacheTtlMs
    ) {
      return Array.from(this.profileCache.values());
    }

    // Fetch from relays
    return this.fetchProfiles();
  }

  /**
   * Fetch profiles from relays
   */
  private async fetchProfiles(): Promise<Profile[]> {
    const filter: NostrFilter = {
      kinds: [KIND_METADATA],
      limit: this.maxFetch,
    };

    const events = await this.queryWithTimeout(filter);

    // Group by pubkey and get latest event for each
    const latestByPubkey = new Map<string, NostrEvent>();
    for (const event of events) {
      const existing = latestByPubkey.get(event.pubkey);
      if (!existing || event.created_at > existing.created_at) {
        latestByPubkey.set(event.pubkey, event);
      }
    }

    // Parse profiles and update cache
    const profiles: Profile[] = [];
    for (const event of latestByPubkey.values()) {
      const profile = this.parseProfile(event);
      if (profile) {
        profiles.push(profile);
        if (this.enableCache) {
          this.profileCache.set(profile.pubkey, profile);
        }
      }
    }

    this.lastCacheRefresh = Date.now();
    return profiles;
  }

  /**
   * Query relays with timeout
   */
  private async queryWithTimeout(filter: NostrFilter): Promise<NostrEvent[]> {
    // Use API if available
    const api = (globalThis as any).nostrApi;
    if (api && typeof api.queryEvents === 'function') {
      try {
        return await api.queryEvents(filter);
      } catch (err) {
        console.warn('[NostrDirectoryAdapter] API query failed, falling back to relay:', err);
      }
    }

    const timeoutPromise = new Promise<NostrEvent[]>((resolve) => {
      setTimeout(() => resolve([]), this.timeoutMs);
    });

    const queryPromise = this.pool.querySync(this.relays, filter);

    return Promise.race([queryPromise, timeoutPromise]);
  }

  /**
   * Parse a kind-0 event into a Profile
   */
  private parseProfile(event: NostrEvent): Profile | null {
    try {
      const metadata = JSON.parse(event.content) as Record<string, unknown>;

      const profile: Profile = {
        pubkey: event.pubkey,
        name: this.getString(metadata, 'name'),
        displayName: this.getString(metadata, 'display_name'),
        picture: this.getString(metadata, 'picture'),
        banner: this.getString(metadata, 'banner'),
        about: this.getString(metadata, 'about'),
        nip05: this.getString(metadata, 'nip05'),
        lud16: this.getString(metadata, 'lud16'),
        lud06: this.getString(metadata, 'lud06'),
        website: this.getString(metadata, 'website'),
        createdAt: event.created_at,
        metadata,
      };

      // Extract merchant-related fields if present
      if (metadata.currencies && Array.isArray(metadata.currencies)) {
        profile.currencies = metadata.currencies.filter(
          (c): c is string => typeof c === 'string'
        );
      }

      if (metadata.merchantTags && Array.isArray(metadata.merchantTags)) {
        profile.merchantTags = metadata.merchantTags.filter(
          (t): t is string => typeof t === 'string'
        );
      }

      // Extract location if present
      if (metadata.location && typeof metadata.location === 'object') {
        const loc = metadata.location as Record<string, unknown>;
        if (typeof loc.lat === 'number' && typeof loc.lon === 'number') {
          profile.location = {
            lat: loc.lat,
            lon: loc.lon,
            address: this.getString(loc, 'address'),
            country: this.getString(loc, 'country'),
            city: this.getString(loc, 'city'),
          };
        }
      }

      return profile;
    } catch {
      return null;
    }
  }

  /**
   * Safely get a string value from an object
   */
  private getString(obj: Record<string, unknown>, key: string): string | undefined {
    const value = obj[key];
    return typeof value === 'string' ? value : undefined;
  }
}

/**
 * Create a NostrDirectoryAdapter instance
 */
export function createNostrDirectoryAdapter(
  config: NostrDirectoryAdapterConfig
): NostrDirectoryAdapter {
  return new NostrDirectoryAdapter(config);
}
