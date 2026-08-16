import type {
  Profile,
  ProfileFilter,
  ProfileSearchResult,
  DirectoryAdapter,
  CacheStore,
  ScoringWeights,
} from '../types/index.js';
import {
  filterProfiles,
  paginateResults,
  parseCursor,
  createCursor,
  splitFilter,
  type FilterCapabilities,
} from '../filters/FilterEngine.js';
import { scoreAndSort, DEFAULT_WEIGHTS } from '../filters/Scoring.js';

/**
 * Configuration for ProfileDirectory
 */
export interface ProfileDirectoryConfig {
  /** Directory adapter for fetching profiles */
  adapter: DirectoryAdapter;
  /** Optional cache for search results */
  cache?: CacheStore<ProfileSearchResult>;
  /** Adapter's filter capabilities */
  capabilities?: FilterCapabilities;
  /** Scoring weights for ranking results */
  scoringWeights?: ScoringWeights;
  /** Default page size */
  defaultLimit?: number;
  /** Maximum page size */
  maxLimit?: number;
  /** Cache TTL for search results in ms */
  cacheTtlMs?: number;
}

/**
 * Default configuration values
 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * ProfileDirectory service for searching and filtering profiles
 * Orchestrates adapter, filtering, scoring, and caching
 */
export class ProfileDirectory {
  private readonly adapter: DirectoryAdapter;
  private readonly cache?: CacheStore<ProfileSearchResult>;
  private readonly capabilities: FilterCapabilities;
  private readonly scoringWeights: ScoringWeights;
  private readonly defaultLimit: number;
  private readonly maxLimit: number;
  private readonly cacheTtlMs: number;

  constructor(config: ProfileDirectoryConfig) {
    this.adapter = config.adapter;
    this.cache = config.cache;
    this.capabilities = config.capabilities ?? {};
    this.scoringWeights = config.scoringWeights ?? DEFAULT_WEIGHTS;
    this.defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
    this.maxLimit = config.maxLimit ?? MAX_LIMIT;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Search for profiles matching the filter
   */
  async search(filter: ProfileFilter = {}): Promise<ProfileSearchResult> {
    // Normalize limit
    const limit = Math.min(
      filter.limit ?? this.defaultLimit,
      this.maxLimit
    );
    const normalizedFilter = { ...filter, limit };

    // Check cache first
    const cacheKey = this.createCacheKey(normalizedFilter);
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return { ...cached, isStale: false };
      }
    }

    // Split filter for server/client processing
    const { serverFilter, clientFilter } = splitFilter(
      normalizedFilter,
      this.capabilities
    );

    // Fetch from adapter
    let result = await this.adapter.search(serverFilter);

    // Apply client-side filtering if needed
    if (this.needsClientFilter(clientFilter)) {
      result = this.applyClientFilter(result, clientFilter, normalizedFilter);
    }

    // Apply scoring and sorting
    result = this.applyScoring(result, normalizedFilter);

    // Apply client-side pagination if adapter doesn't support it
    if (!this.capabilities.pagination) {
      result = this.applyPagination(result, normalizedFilter);
    }

    // Cache the result
    if (this.cache) {
      await this.cache.set(cacheKey, result, this.cacheTtlMs);
    }

    return result;
  }

  /**
   * Get search suggestions (if adapter supports it)
   */
  async suggest(query: string): Promise<string[]> {
    if (!this.adapter.suggest) {
      return [];
    }
    return this.adapter.suggest(query);
  }

  /**
   * Search with automatic pagination handling
   * Returns an async iterator for convenient iteration
   */
  async *searchAll(
    filter: ProfileFilter = {}
  ): AsyncGenerator<Profile[], void, unknown> {
    let cursor = filter.cursor;
    let hasMore = true;

    while (hasMore) {
      const result = await this.search({ ...filter, cursor });
      yield result.profiles;

      hasMore = !!result.cursor;
      cursor = result.cursor;
    }
  }

  /**
   * Check if client-side filtering is needed
   */
  private needsClientFilter(clientFilter: ProfileFilter): boolean {
    return !!(
      clientFilter.query ||
      clientFilter.merchantOnly ||
      clientFilter.currencies ||
      clientFilter.location
    );
  }

  /**
   * Apply client-side filtering
   */
  private applyClientFilter(
    result: ProfileSearchResult,
    clientFilter: ProfileFilter,
    _originalFilter: ProfileFilter
  ): ProfileSearchResult {
    const filtered = filterProfiles(result.profiles, clientFilter);

    return {
      ...result,
      profiles: filtered,
      // Clear cursor since we've filtered client-side
      cursor: undefined,
    };
  }

  /**
   * Apply scoring and sorting
   */
  private applyScoring(
    result: ProfileSearchResult,
    filter: ProfileFilter
  ): ProfileSearchResult {
    const scored = scoreAndSort(
      result.profiles,
      filter,
      this.scoringWeights
    );

    return {
      ...result,
      profiles: scored,
    };
  }

  /**
   * Apply client-side pagination
   */
  private applyPagination(
    result: ProfileSearchResult,
    filter: ProfileFilter
  ): ProfileSearchResult {
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? this.defaultLimit;

    const { items, hasMore, nextOffset } = paginateResults(
      result.profiles,
      limit,
      offset
    );

    return {
      profiles: items,
      cursor: hasMore && nextOffset !== undefined
        ? createCursor(nextOffset)
        : undefined,
      totalCount: result.profiles.length,
    };
  }

  /**
   * Create a cache key for the filter
   */
  private createCacheKey(filter: ProfileFilter): string {
    const parts: string[] = ['search'];

    if (filter.query) parts.push(`q:${filter.query}`);
    if (filter.merchantOnly) parts.push('merchant');
    if (filter.currencies) parts.push(`cur:${filter.currencies.sort().join(',')}`);
    if (filter.location) {
      parts.push(`loc:${filter.location.lat},${filter.location.lon},${filter.location.radiusKm}`);
    }
    if (filter.limit) parts.push(`l:${filter.limit}`);
    if (filter.cursor) parts.push(`c:${filter.cursor}`);

    return parts.join(':');
  }

  /**
   * Clear the search cache
   */
  async clearCache(): Promise<void> {
    if (this.cache) {
      await this.cache.clear();
    }
  }
}

/**
 * Create a ProfileDirectory instance
 */
export function createProfileDirectory(
  config: ProfileDirectoryConfig
): ProfileDirectory {
  return new ProfileDirectory(config);
}
