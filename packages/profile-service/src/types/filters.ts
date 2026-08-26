import type { Profile } from './profile.js';

/**
 * Location filter with radius
 */
export interface LocationFilter {
  lat: number;
  lon: number;
  /** Geo radius filter in kilometers */
  radiusKm: number;
}

/**
 * Profile search filter options
 */
export interface ProfileFilter {
  /** Text search on name/displayName/about */
  query?: string;
  /** Only return merchant profiles */
  merchantOnly?: boolean;
  /** Filter by supported currency codes */
  currencies?: string[];
  /** Geo location filter with radius */
  location?: LocationFilter;
  /** Maximum results to return */
  limit?: number;
  /** Pagination cursor token */
  cursor?: string;
}

/**
 * Result of a profile search
 */
export interface ProfileSearchResult {
  profiles: Profile[];
  /** Pagination cursor for next page */
  cursor?: string;
  /** Whether results are from cache (potentially stale) */
  isStale?: boolean;
  /** Total count if known */
  totalCount?: number;
}

/**
 * Scoring weights for profile ranking
 */
export interface ScoringWeights {
  /** Weight for query text match (0-1) */
  queryMatch: number;
  /** Weight for recency (0-1) */
  recency: number;
  /** Weight for proximity (0-1) */
  proximity: number;
}
