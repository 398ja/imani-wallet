/**
 * ProfileFetcher
 *
 * Fetches Nostr profile metadata for display purposes.
 */

import type { ApiAdapter } from '../adapters';
import type { NostrProfile } from '../types';

/**
 * Profile fetch result
 */
export interface ProfileResult {
  /** Whether fetch was successful */
  success: boolean;

  /** Profile data */
  profile?: NostrProfile;

  /** Display name (best available) */
  displayName?: string;

  /** Picture URL */
  picture?: string;

  /** Error message if failed */
  error?: string;
}

/**
 * ProfileFetcher configuration
 */
export interface ProfileFetcherConfig {
  /** Cache TTL in milliseconds */
  cacheTtl?: number;

  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Cache entry
 */
interface CacheEntry {
  result: ProfileResult;
  timestamp: number;
}

/**
 * ProfileFetcher
 *
 * Fetches and caches Nostr profile data.
 */
export class ProfileFetcher {
  private apiAdapter?: ApiAdapter;
  private cacheTtl: number;
  private cache: Map<string, CacheEntry>;

  constructor(apiAdapter?: ApiAdapter, config: ProfileFetcherConfig = {}) {
    this.apiAdapter = apiAdapter;
    this.cacheTtl = config.cacheTtl || 10 * 60 * 1000; // 10 minutes default
    this.cache = new Map();
  }

  /**
   * Fetch profile for a public key
   *
   * @param pubkeyHex - Hex public key
   * @returns Profile result
   */
  async fetch(pubkeyHex: string): Promise<ProfileResult> {
    // Check cache first
    const cached = this.getFromCache(pubkeyHex);
    if (cached) {
      return cached;
    }

    // No API adapter - return minimal result
    if (!this.apiAdapter) {
      return {
        success: false,
        error: 'No API adapter configured',
      };
    }

    try {
      const profile = await this.apiAdapter.getProfile(pubkeyHex);

      if (!profile) {
        const result: ProfileResult = {
          success: false,
          error: 'Profile not found',
        };
        this.setCache(pubkeyHex, result);
        return result;
      }

      const displayName = this.extractDisplayName(profile);
      const result: ProfileResult = {
        success: true,
        profile,
        displayName,
        picture: profile.picture,
      };

      this.setCache(pubkeyHex, result);
      return result;
    } catch (error) {
      const result: ProfileResult = {
        success: false,
        error: (error as Error).message,
      };
      // Don't cache errors
      return result;
    }
  }

  /**
   * Get display name from profile
   * Returns the best available name
   */
  async getDisplayName(pubkeyHex: string, fallback?: string): Promise<string> {
    const result = await this.fetch(pubkeyHex);

    if (result.displayName) {
      return result.displayName;
    }

    // Use fallback or truncated pubkey
    return fallback || this.truncatePubkey(pubkeyHex);
  }

  /**
   * Get profile picture URL
   */
  async getPicture(pubkeyHex: string): Promise<string | undefined> {
    const result = await this.fetch(pubkeyHex);
    return result.picture;
  }

  /**
   * Clear the profile cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Extract display name from profile
   * Prefers display_name > name > nip05 username
   */
  private extractDisplayName(profile: NostrProfile): string | undefined {
    // Check display_name first (common field)
    const displayName = (profile as Record<string, unknown>).display_name;
    if (typeof displayName === 'string' && displayName.trim()) {
      return displayName.trim();
    }

    // Then name
    if (profile.name?.trim()) {
      return profile.name.trim();
    }

    // Then NIP-05 username part
    if (profile.nip05) {
      const username = profile.nip05.split('@')[0];
      if (username?.trim()) {
        return username.trim();
      }
    }

    return undefined;
  }

  /**
   * Truncate pubkey for display
   */
  private truncatePubkey(pubkey: string): string {
    if (pubkey.length <= 16) return pubkey;
    return `${pubkey.slice(0, 8)}...${pubkey.slice(-6)}`;
  }

  /**
   * Get from cache if not expired
   */
  private getFromCache(pubkey: string): ProfileResult | null {
    const entry = this.cache.get(pubkey);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.cacheTtl) {
      this.cache.delete(pubkey);
      return null;
    }

    return entry.result;
  }

  /**
   * Set cache entry
   */
  private setCache(pubkey: string, result: ProfileResult): void {
    this.cache.set(pubkey, {
      result,
      timestamp: Date.now(),
    });
  }
}

/**
 * Create a profile fetcher instance
 */
export function createProfileFetcher(
  apiAdapter?: ApiAdapter,
  config?: ProfileFetcherConfig
): ProfileFetcher {
  return new ProfileFetcher(apiAdapter, config);
}
