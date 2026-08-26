import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  scoreProfile,
  scoreAndSort,
  DEFAULT_WEIGHTS,
} from '../../src/filters/Scoring.js';
import type { Profile, ProfileFilter } from '../../src/types/index.js';

// Helper to create test profiles
function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    pubkey: 'a'.repeat(64),
    name: 'Test User',
    ...overrides,
  };
}

describe('scoreProfile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('query matching', () => {
    it('should give highest score for exact match', () => {
      const profile = createProfile({ name: 'coffee' });
      const filter: ProfileFilter = { query: 'coffee' };

      const score = scoreProfile(profile, filter);

      // Exact match should max out query weight (but recency + proximity add to total)
      expect(score).toBeGreaterThan(0.85);
    });

    it('should give high score for starts-with match', () => {
      const profile = createProfile({ name: 'coffee shop' });
      const filter: ProfileFilter = { query: 'coffee' };

      const score = scoreProfile(profile, filter);

      expect(score).toBeGreaterThan(0.8);
    });

    it('should give medium score for contains match', () => {
      const profile = createProfile({ name: 'best coffee in town' });
      const filter: ProfileFilter = { query: 'coffee' };

      const score = scoreProfile(profile, filter);

      expect(score).toBeGreaterThan(0.6);
    });

    it('should give low score for no match', () => {
      const profile = createProfile({ name: 'tea shop' });
      const filter: ProfileFilter = { query: 'coffee' };

      const score = scoreProfile(profile, filter);

      // Should still have recency component
      expect(score).toBeLessThan(0.5);
    });

    it('should match across multiple fields', () => {
      const profile = createProfile({
        name: 'Shop',
        about: 'Best coffee in town',
      });
      const filter: ProfileFilter = { query: 'coffee' };

      const score = scoreProfile(profile, filter);

      expect(score).toBeGreaterThan(0.6);
    });
  });

  describe('recency scoring', () => {
    it('should give high score to recent profiles', () => {
      const now = Math.floor(Date.now() / 1000);
      const profile = createProfile({ createdAt: now - 3600 }); // 1 hour ago
      const filter: ProfileFilter = {};

      const score = scoreProfile(profile, filter);

      expect(score).toBeGreaterThan(0.9);
    });

    it('should give medium score to month-old profiles', () => {
      const now = Math.floor(Date.now() / 1000);
      const profile = createProfile({ createdAt: now - 15 * 86400 }); // 15 days ago
      const filter: ProfileFilter = {};

      const score = scoreProfile(profile, filter);

      expect(score).toBeGreaterThan(0.7);
      expect(score).toBeLessThan(0.95);
    });

    it('should give low score to old profiles', () => {
      const now = Math.floor(Date.now() / 1000);
      const profile = createProfile({ createdAt: now - 400 * 86400 }); // 400 days ago
      const filter: ProfileFilter = {};

      const score = scoreProfile(profile, filter);

      // Old profiles still get query and proximity weights (0.5 + 0.3) plus small recency (0.04)
      expect(score).toBeLessThan(0.9);
      expect(score).toBeGreaterThan(0.8); // 0.5 + 0.3 + 0.2*0.2 = 0.84
    });

    it('should handle missing createdAt', () => {
      const profile = createProfile({ createdAt: undefined });
      const filter: ProfileFilter = {};

      const score = scoreProfile(profile, filter);

      // Default middle score for recency (0.5 * 0.2 = 0.1) plus full query and proximity
      // Total: 0.5 + 0.3 + 0.1 = 0.9
      expect(score).toBeGreaterThan(0.85);
      expect(score).toBeLessThanOrEqual(0.9);
    });
  });

  describe('proximity scoring', () => {
    it('should give high score to nearby profiles', () => {
      const profile = createProfile({
        location: { lat: 45.51, lon: -122.61 }, // ~1.5 km from center
      });
      const filter: ProfileFilter = {
        location: { lat: 45.5, lon: -122.6, radiusKm: 10 },
      };

      const score = scoreProfile(profile, filter);

      expect(score).toBeGreaterThan(0.8);
    });

    it('should give lower score to profiles at edge of radius', () => {
      const profile = createProfile({
        location: { lat: 45.59, lon: -122.6 }, // ~10 km from center
      });
      const filter: ProfileFilter = {
        location: { lat: 45.5, lon: -122.6, radiusKm: 10 },
      };

      const score = scoreProfile(profile, filter);

      expect(score).toBeGreaterThan(0.6);
      expect(score).toBeLessThan(0.9);
    });

    it('should give zero proximity score to profiles without location', () => {
      const profileWithLocation = createProfile({
        location: { lat: 45.5, lon: -122.6 },
      });
      const profileWithoutLocation = createProfile({});
      const filter: ProfileFilter = {
        location: { lat: 45.5, lon: -122.6, radiusKm: 10 },
      };

      const scoreWith = scoreProfile(profileWithLocation, filter);
      const scoreWithout = scoreProfile(profileWithoutLocation, filter);

      expect(scoreWith).toBeGreaterThan(scoreWithout);
    });

    it('should not affect score when no location filter', () => {
      const profile = createProfile({});
      const filter: ProfileFilter = {};

      const score = scoreProfile(profile, filter);

      // Should have full proximity weight added
      expect(score).toBeGreaterThan(0.5);
    });
  });

  describe('custom weights', () => {
    it('should respect custom weights', () => {
      const now = Math.floor(Date.now() / 1000);
      const profile = createProfile({
        name: 'coffee',
        createdAt: now,
      });
      const filter: ProfileFilter = { query: 'coffee' };

      // All weight on query
      const queryOnlyScore = scoreProfile(profile, filter, {
        queryMatch: 1,
        recency: 0,
        proximity: 0,
      });

      // All weight on recency
      const recencyOnlyScore = scoreProfile(profile, filter, {
        queryMatch: 0,
        recency: 1,
        proximity: 0,
      });

      expect(queryOnlyScore).toBeCloseTo(1, 1);
      expect(recencyOnlyScore).toBeCloseTo(1, 1);
    });
  });
});

describe('scoreAndSort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should sort profiles by score descending', () => {
    const now = Math.floor(Date.now() / 1000);
    const profiles = [
      createProfile({ name: 'tea shop', createdAt: now - 86400 }),
      createProfile({ name: 'best coffee around', createdAt: now }), // Contains
      createProfile({ name: 'coffee', createdAt: now }), // Exact match
    ];
    const filter: ProfileFilter = { query: 'coffee' };

    const sorted = scoreAndSort(profiles, filter);

    expect(sorted[0].name).toBe('coffee'); // Exact match + recent
    expect(sorted[1].name).toBe('best coffee around'); // Contains + recent
    expect(sorted[2].name).toBe('tea shop'); // No match
  });

  it('should handle empty profiles array', () => {
    const result = scoreAndSort([], { query: 'test' });

    expect(result).toEqual([]);
  });

  it('should handle empty filter', () => {
    const now = Math.floor(Date.now() / 1000);
    const profiles = [
      createProfile({ name: 'Old', createdAt: now - 400 * 86400 }),
      createProfile({ name: 'New', createdAt: now }),
    ];

    const sorted = scoreAndSort(profiles, {});

    // More recent should come first
    expect(sorted[0].name).toBe('New');
  });
});

describe('DEFAULT_WEIGHTS', () => {
  it('should sum to 1', () => {
    const sum = DEFAULT_WEIGHTS.queryMatch + DEFAULT_WEIGHTS.recency + DEFAULT_WEIGHTS.proximity;
    expect(sum).toBe(1);
  });
});
