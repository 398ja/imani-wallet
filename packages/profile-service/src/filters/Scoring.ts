import type { Profile, ScoringWeights, ProfileFilter } from '../types/index.js';
import { haversineDistance } from '../utils/geo.js';

/**
 * Default scoring weights
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  queryMatch: 0.5,
  recency: 0.2,
  proximity: 0.3,
};

/**
 * Score a profile based on query match, recency, and proximity
 */
export function scoreProfile(
  profile: Profile,
  filter: ProfileFilter,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
  let score = 0;

  // Query match score (0-1)
  if (filter.query) {
    const queryScore = calculateQueryMatchScore(profile, filter.query);
    score += queryScore * weights.queryMatch;
  } else {
    // No query means all profiles match equally on this dimension
    score += weights.queryMatch;
  }

  // Recency score (0-1)
  const recencyScore = calculateRecencyScore(profile);
  score += recencyScore * weights.recency;

  // Proximity score (0-1)
  if (filter.location && profile.location) {
    const proximityScore = calculateProximityScore(
      profile.location,
      filter.location
    );
    score += proximityScore * weights.proximity;
  } else if (!filter.location) {
    // No location filter means all profiles score equally on proximity
    score += weights.proximity;
  }
  // If filter has location but profile doesn't, proximity score is 0

  return score;
}

/**
 * Calculate query match score based on text matching
 */
function calculateQueryMatchScore(profile: Profile, query: string): number {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return 1;

  const searchableFields = [
    profile.name,
    profile.displayName,
    profile.about,
    profile.nip05,
    ...(profile.merchantTags ?? []),
  ].filter(Boolean) as string[];

  let maxScore = 0;

  for (const field of searchableFields) {
    const normalizedField = field.toLowerCase();

    // Exact match gets highest score
    if (normalizedField === normalizedQuery) {
      return 1;
    }

    // Starts with query gets high score
    if (normalizedField.startsWith(normalizedQuery)) {
      maxScore = Math.max(maxScore, 0.9);
      continue;
    }

    // Contains query gets medium score
    if (normalizedField.includes(normalizedQuery)) {
      maxScore = Math.max(maxScore, 0.7);
      continue;
    }

    // Word boundary match
    const words = normalizedField.split(/\s+/);
    for (const word of words) {
      if (word.startsWith(normalizedQuery)) {
        maxScore = Math.max(maxScore, 0.6);
        break;
      }
    }
  }

  return maxScore;
}

/**
 * Calculate recency score based on profile creation time
 * More recent profiles score higher
 */
function calculateRecencyScore(profile: Profile): number {
  if (!profile.createdAt) return 0.5; // Default to middle score if unknown

  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - profile.createdAt;

  // Profiles updated in last day get full score
  const oneDay = 86400;
  if (ageSeconds < oneDay) return 1;

  // Profiles updated in last week get high score
  const oneWeek = 7 * oneDay;
  if (ageSeconds < oneWeek) return 0.9;

  // Profiles updated in last month get medium score
  const oneMonth = 30 * oneDay;
  if (ageSeconds < oneMonth) return 0.7;

  // Profiles updated in last year get lower score
  const oneYear = 365 * oneDay;
  if (ageSeconds < oneYear) return 0.5;

  // Very old profiles get minimum score
  return 0.2;
}

/**
 * Calculate proximity score based on distance from filter location
 */
function calculateProximityScore(
  profileLocation: NonNullable<Profile['location']>,
  filterLocation: NonNullable<ProfileFilter['location']>
): number {
  const distance = haversineDistance(
    filterLocation.lat,
    filterLocation.lon,
    profileLocation.lat,
    profileLocation.lon
  );

  // Within radius gets full score, scaled by how close
  if (distance <= filterLocation.radiusKm) {
    // Closer = higher score
    return 1 - (distance / filterLocation.radiusKm) * 0.3;
  }

  // Outside radius but close gets partial score
  const maxConsideredDistance = filterLocation.radiusKm * 2;
  if (distance <= maxConsideredDistance) {
    return 0.3 * (1 - (distance - filterLocation.radiusKm) / filterLocation.radiusKm);
  }

  return 0;
}

/**
 * Sort profiles by score (descending)
 */
export function sortByScore(
  profiles: Array<{ profile: Profile; score: number }>
): Profile[] {
  return profiles
    .sort((a, b) => b.score - a.score)
    .map((item) => item.profile);
}

/**
 * Score and sort profiles
 */
export function scoreAndSort(
  profiles: Profile[],
  filter: ProfileFilter,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): Profile[] {
  const scored = profiles.map((profile) => ({
    profile,
    score: scoreProfile(profile, filter, weights),
  }));

  return sortByScore(scored);
}
