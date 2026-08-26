import { describe, it, expect } from 'vitest';
import {
  filterProfiles,
  filterMerchantOnly,
  filterByCurrencies,
  filterByQuery,
  filterByLocation,
  paginateResults,
  parseCursor,
  createCursor,
  splitFilter,
} from '../../src/filters/FilterEngine.js';
import type { Profile, ProfileFilter } from '../../src/types/index.js';

// Helper to create test profiles
function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    pubkey: 'a'.repeat(64),
    name: 'Test User',
    ...overrides,
  };
}

describe('filterMerchantOnly', () => {
  it('should include profiles with merchant tags', () => {
    const profiles = [
      createProfile({ merchantTags: ['merchant'] }),
      createProfile({ merchantTags: [] }),
      createProfile({}),
    ];

    const result = filterMerchantOnly(profiles);

    expect(result).toHaveLength(1);
    expect(result[0].merchantTags).toContain('merchant');
  });

  it('should include profiles with currencies', () => {
    const profiles = [
      createProfile({ currencies: ['USD', 'XAF'] }),
      createProfile({}),
    ];

    const result = filterMerchantOnly(profiles);

    expect(result).toHaveLength(1);
    expect(result[0].currencies).toContain('USD');
  });

  it('should include profiles with either merchant tags or currencies', () => {
    const profiles = [
      createProfile({ merchantTags: ['pos'] }),
      createProfile({ currencies: ['EUR'] }),
      createProfile({}),
    ];

    const result = filterMerchantOnly(profiles);

    expect(result).toHaveLength(2);
  });
});

describe('filterByCurrencies', () => {
  it('should filter profiles by currency', () => {
    const profiles = [
      createProfile({ currencies: ['USD', 'XAF'] }),
      createProfile({ currencies: ['EUR'] }),
      createProfile({ currencies: ['USD'] }),
      createProfile({}),
    ];

    const result = filterByCurrencies(profiles, ['USD']);

    expect(result).toHaveLength(2);
  });

  it('should match multiple currencies (OR)', () => {
    const profiles = [
      createProfile({ currencies: ['USD'] }),
      createProfile({ currencies: ['EUR'] }),
      createProfile({ currencies: ['GBP'] }),
    ];

    const result = filterByCurrencies(profiles, ['USD', 'EUR']);

    expect(result).toHaveLength(2);
  });

  it('should be case-insensitive', () => {
    const profiles = [
      createProfile({ currencies: ['usd'] }),
      createProfile({ currencies: ['EUR'] }),
    ];

    const result = filterByCurrencies(profiles, ['USD', 'eur']);

    expect(result).toHaveLength(2);
  });

  it('should exclude profiles without currencies', () => {
    const profiles = [
      createProfile({ currencies: ['USD'] }),
      createProfile({}),
    ];

    const result = filterByCurrencies(profiles, ['USD']);

    expect(result).toHaveLength(1);
  });
});

describe('filterByQuery', () => {
  it('should match name', () => {
    const profiles = [
      createProfile({ name: 'Alice Coffee Shop' }),
      createProfile({ name: 'Bob Restaurant' }),
    ];

    const result = filterByQuery(profiles, 'coffee');

    expect(result).toHaveLength(1);
    expect(result[0].name).toContain('Coffee');
  });

  it('should match displayName', () => {
    const profiles = [
      createProfile({ displayName: 'Best Pizza Place' }),
      createProfile({ displayName: 'Sushi Bar' }),
    ];

    const result = filterByQuery(profiles, 'pizza');

    expect(result).toHaveLength(1);
  });

  it('should match about', () => {
    const profiles = [
      createProfile({ about: 'We serve the best tacos in town' }),
      createProfile({ about: 'Fresh coffee daily' }),
    ];

    const result = filterByQuery(profiles, 'tacos');

    expect(result).toHaveLength(1);
  });

  it('should match nip05', () => {
    const profiles = [
      createProfile({ nip05: 'alice@wonderland.com' }),
      createProfile({ nip05: 'bob@example.com' }),
    ];

    const result = filterByQuery(profiles, 'wonderland');

    expect(result).toHaveLength(1);
  });

  it('should match merchant tags', () => {
    const profiles = [
      createProfile({ merchantTags: ['restaurant', 'food'] }),
      createProfile({ merchantTags: ['retail'] }),
    ];

    const result = filterByQuery(profiles, 'restaurant');

    expect(result).toHaveLength(1);
  });

  it('should be case-insensitive', () => {
    const profiles = [
      createProfile({ name: 'UPPERCASE NAME' }),
    ];

    const result = filterByQuery(profiles, 'uppercase');

    expect(result).toHaveLength(1);
  });

  it('should return all profiles for empty query', () => {
    const profiles = [
      createProfile({ name: 'Alice' }),
      createProfile({ name: 'Bob' }),
    ];

    const result = filterByQuery(profiles, '');

    expect(result).toHaveLength(2);
  });
});

describe('filterByLocation', () => {
  const centerLat = 45.5;
  const centerLon = -122.6;

  it('should include profiles within radius', () => {
    const profiles = [
      createProfile({ location: { lat: 45.51, lon: -122.61 } }), // ~1.5 km away
      createProfile({ location: { lat: 46.0, lon: -122.6 } }), // ~55 km away
    ];

    const result = filterByLocation(profiles, {
      lat: centerLat,
      lon: centerLon,
      radiusKm: 10,
    });

    expect(result).toHaveLength(1);
  });

  it('should exclude profiles without location', () => {
    const profiles = [
      createProfile({ location: { lat: 45.5, lon: -122.6 } }),
      createProfile({}),
    ];

    const result = filterByLocation(profiles, {
      lat: centerLat,
      lon: centerLon,
      radiusKm: 10,
    });

    expect(result).toHaveLength(1);
  });

  it('should include profiles exactly at center', () => {
    const profiles = [
      createProfile({ location: { lat: centerLat, lon: centerLon } }),
    ];

    const result = filterByLocation(profiles, {
      lat: centerLat,
      lon: centerLon,
      radiusKm: 1,
    });

    expect(result).toHaveLength(1);
  });
});

describe('filterProfiles', () => {
  it('should apply all filters', () => {
    const profiles = [
      createProfile({
        name: 'Coffee Shop',
        merchantTags: ['merchant'],
        currencies: ['USD'],
        location: { lat: 45.5, lon: -122.6 },
      }),
      createProfile({
        name: 'Coffee House',
        merchantTags: ['merchant'],
        currencies: ['EUR'],
        location: { lat: 45.5, lon: -122.6 },
      }),
      createProfile({
        name: 'Tea Shop',
        merchantTags: ['merchant'],
        currencies: ['USD'],
        location: { lat: 45.5, lon: -122.6 },
      }),
    ];

    const filter: ProfileFilter = {
      query: 'coffee',
      merchantOnly: true,
      currencies: ['USD'],
      location: { lat: 45.5, lon: -122.6, radiusKm: 10 },
    };

    const result = filterProfiles(profiles, filter);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Coffee Shop');
  });

  it('should return all profiles with empty filter', () => {
    const profiles = [
      createProfile({ name: 'Alice' }),
      createProfile({ name: 'Bob' }),
    ];

    const result = filterProfiles(profiles, {});

    expect(result).toHaveLength(2);
  });
});

describe('paginateResults', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('should return first page', () => {
    const result = paginateResults(items, 2);

    expect(result.items).toEqual(['a', 'b']);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(2);
  });

  it('should return middle page', () => {
    const result = paginateResults(items, 2, 2);

    expect(result.items).toEqual(['c', 'd']);
    expect(result.hasMore).toBe(true);
    expect(result.nextOffset).toBe(4);
  });

  it('should return last page', () => {
    const result = paginateResults(items, 2, 4);

    expect(result.items).toEqual(['e']);
    expect(result.hasMore).toBe(false);
    expect(result.nextOffset).toBeUndefined();
  });

  it('should return all items without limit', () => {
    const result = paginateResults(items);

    expect(result.items).toEqual(items);
    expect(result.hasMore).toBe(false);
  });

  it('should handle offset beyond array', () => {
    const result = paginateResults(items, 2, 10);

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });
});

describe('parseCursor / createCursor', () => {
  it('should roundtrip cursor', () => {
    const offset = 42;
    const cursor = createCursor(offset);
    const parsed = parseCursor(cursor);

    expect(parsed).toBe(offset);
  });

  it('should return 0 for invalid cursor', () => {
    expect(parseCursor('invalid')).toBe(0);
    expect(parseCursor('')).toBe(0);
    expect(parseCursor(undefined)).toBe(0);
  });
});

describe('splitFilter', () => {
  it('should split filter based on capabilities', () => {
    const filter: ProfileFilter = {
      query: 'test',
      merchantOnly: true,
      currencies: ['USD'],
      location: { lat: 45, lon: -122, radiusKm: 10 },
      limit: 20,
    };

    const { serverFilter, clientFilter } = splitFilter(filter, {
      query: true,
      merchantOnly: false,
      currencies: true,
      location: false,
      pagination: true,
    });

    expect(serverFilter).toEqual({
      query: 'test',
      currencies: ['USD'],
      limit: 20,
    });

    expect(clientFilter).toEqual({
      merchantOnly: true,
      location: { lat: 45, lon: -122, radiusKm: 10 },
    });
  });

  it('should put all filters client-side with no capabilities', () => {
    const filter: ProfileFilter = {
      query: 'test',
      merchantOnly: true,
    };

    const { serverFilter, clientFilter } = splitFilter(filter, {});

    expect(serverFilter).toEqual({});
    expect(clientFilter).toEqual(filter);
  });
});
