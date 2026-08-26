import type { Profile, ProfileFilter } from '../types/index.js';
import { isWithinRadius, boundingBox, isInBoundingBox } from '../utils/geo.js';

/**
 * Filter profiles based on ProfileFilter criteria
 * Applies filters in order of computational cost (cheapest first)
 */
export function filterProfiles(
  profiles: Profile[],
  filter: ProfileFilter
): Profile[] {
  let result = profiles;

  // 1. Merchant-only filter (cheapest - simple boolean check)
  if (filter.merchantOnly) {
    result = filterMerchantOnly(result);
  }

  // 2. Currency filter (cheap - array intersection)
  if (filter.currencies && filter.currencies.length > 0) {
    result = filterByCurrencies(result, filter.currencies);
  }

  // 3. Text query filter (medium cost - string matching)
  if (filter.query) {
    result = filterByQuery(result, filter.query);
  }

  // 4. Geo filter (most expensive - distance calculation)
  if (filter.location) {
    result = filterByLocation(result, filter.location);
  }

  return result;
}

/**
 * Filter to only merchant profiles
 */
export function filterMerchantOnly(profiles: Profile[]): Profile[] {
  return profiles.filter((profile) => {
    // Has merchant tags
    if (profile.merchantTags && profile.merchantTags.length > 0) {
      return true;
    }
    // Has currencies defined (typical for merchants)
    if (profile.currencies && profile.currencies.length > 0) {
      return true;
    }
    return false;
  });
}

/**
 * Filter profiles by supported currencies
 */
export function filterByCurrencies(
  profiles: Profile[],
  currencies: string[]
): Profile[] {
  const normalizedCurrencies = new Set(
    currencies.map((c) => c.toUpperCase())
  );

  return profiles.filter((profile) => {
    if (!profile.currencies || profile.currencies.length === 0) {
      return false;
    }

    // Check if profile supports any of the requested currencies
    return profile.currencies.some((c) =>
      normalizedCurrencies.has(c.toUpperCase())
    );
  });
}

/**
 * Filter profiles by text query
 * Searches in name, displayName, about, nip05, merchantTags
 */
export function filterByQuery(profiles: Profile[], query: string): Profile[] {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return profiles;

  return profiles.filter((profile) => {
    const searchableText = [
      profile.name,
      profile.displayName,
      profile.about,
      profile.nip05,
      ...(profile.merchantTags ?? []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return searchableText.includes(normalizedQuery);
  });
}

/**
 * Filter profiles by geographic location
 * Uses bounding box pre-filter for efficiency
 */
export function filterByLocation(
  profiles: Profile[],
  location: NonNullable<ProfileFilter['location']>
): Profile[] {
  // Pre-calculate bounding box for quick filtering
  const box = boundingBox(location.lat, location.lon, location.radiusKm);

  return profiles.filter((profile) => {
    if (!profile.location) return false;

    const { lat, lon } = profile.location;

    // Quick bounding box check first
    if (!isInBoundingBox(lat, lon, box)) {
      return false;
    }

    // Accurate distance check
    return isWithinRadius(
      location.lat,
      location.lon,
      lat,
      lon,
      location.radiusKm
    );
  });
}

/**
 * Apply pagination to results
 */
export function paginateResults<T>(
  items: T[],
  limit?: number,
  offset: number = 0
): { items: T[]; hasMore: boolean; nextOffset?: number } {
  if (!limit) {
    return {
      items: items.slice(offset),
      hasMore: false,
    };
  }

  const start = offset;
  const end = start + limit;
  const paginatedItems = items.slice(start, end);
  const hasMore = end < items.length;

  return {
    items: paginatedItems,
    hasMore,
    nextOffset: hasMore ? end : undefined,
  };
}

/**
 * Parse cursor to offset
 */
export function parseCursor(cursor?: string): number {
  if (!cursor) return 0;

  try {
    const decoded = atob(cursor);
    const offset = parseInt(decoded, 10);
    return isNaN(offset) ? 0 : Math.max(0, offset);
  } catch {
    return 0;
  }
}

/**
 * Create cursor from offset
 */
export function createCursor(offset: number): string {
  return btoa(offset.toString());
}

/**
 * Filter capabilities that an adapter might support
 */
export interface FilterCapabilities {
  /** Adapter supports text search server-side */
  query?: boolean;
  /** Adapter supports merchant filter server-side */
  merchantOnly?: boolean;
  /** Adapter supports currency filter server-side */
  currencies?: boolean;
  /** Adapter supports geo filter server-side */
  location?: boolean;
  /** Adapter supports pagination server-side */
  pagination?: boolean;
}

/**
 * Split filter into server-side and client-side parts
 * based on adapter capabilities
 */
export function splitFilter(
  filter: ProfileFilter,
  capabilities: FilterCapabilities
): { serverFilter: ProfileFilter; clientFilter: ProfileFilter } {
  const serverFilter: ProfileFilter = {};
  const clientFilter: ProfileFilter = {};

  if (filter.query) {
    if (capabilities.query) {
      serverFilter.query = filter.query;
    } else {
      clientFilter.query = filter.query;
    }
  }

  if (filter.merchantOnly) {
    if (capabilities.merchantOnly) {
      serverFilter.merchantOnly = filter.merchantOnly;
    } else {
      clientFilter.merchantOnly = filter.merchantOnly;
    }
  }

  if (filter.currencies) {
    if (capabilities.currencies) {
      serverFilter.currencies = filter.currencies;
    } else {
      clientFilter.currencies = filter.currencies;
    }
  }

  if (filter.location) {
    if (capabilities.location) {
      serverFilter.location = filter.location;
    } else {
      clientFilter.location = filter.location;
    }
  }

  // Pagination is always passed to server if supported
  if (capabilities.pagination) {
    serverFilter.limit = filter.limit;
    serverFilter.cursor = filter.cursor;
  }

  return { serverFilter, clientFilter };
}
