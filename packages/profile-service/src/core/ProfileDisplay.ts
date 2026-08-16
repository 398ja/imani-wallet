import type { Profile, CacheStore, LookupAdapter } from '../types/index.js';
import { isValidPubkey, isValidNip05 } from '../utils/validate.js';

/**
 * Types of identifier inputs
 */
export type IdentifierType = 'npub' | 'nip05' | 'pubkeyHex' | 'unknown';

/**
 * Profile display information
 */
export interface ProfileDisplayInfo {
  /** Original identifier input */
  identifier: string;
  /** Detected identifier type */
  identifierType: IdentifierType;
  /** Resolved hex pubkey (null if resolution failed) */
  pubkey: string | null;
  /** Best display name (displayName or name) */
  displayName: string | null;
  /** NIP-05 identifier if available */
  nip05: string | null;
  /** Profile picture URL */
  picture: string | null;
  /** Full profile (if resolved) */
  profile: Profile | null;
  /** Error message if resolution failed */
  error?: string;
}

/**
 * Configuration for ProfileDisplayResolver
 */
export interface ProfileDisplayResolverConfig {
  /** Profile lookup adapter */
  lookupAdapter: LookupAdapter;
  /** NIP-05 resolver function */
  nip05Resolver?: (identifier: string) => Promise<{ pubkey: string } | null>;
  /** Cache for resolved display info */
  cache?: CacheStore<ProfileDisplayInfo>;
}

/**
 * Check if a string is a valid npub
 */
export function isValidNpub(str: string): boolean {
  if (!str.startsWith('npub1')) {
    return false;
  }
  // npub is 63 characters: 'npub1' (5) + 58 bech32 chars
  if (str.length !== 63) {
    return false;
  }
  // Check for valid bech32 characters
  return /^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(str);
}

/**
 * Convert npub to hex pubkey
 * Uses nostr-tools nip19 if available globally
 */
export function npubToHex(npub: string): string | null {
  if (!isValidNpub(npub)) {
    return null;
  }

  // Try to use nostr-tools if available
  if (typeof globalThis !== 'undefined') {
    const nostrTools = (globalThis as Record<string, unknown>).NostrTools as
      | { nip19?: { decode?: (str: string) => { type: string; data: string } } }
      | undefined;

    if (nostrTools?.nip19?.decode) {
      try {
        const decoded = nostrTools.nip19.decode(npub);
        if (decoded.type === 'npub') {
          return decoded.data;
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Convert hex pubkey to npub
 * Uses nostr-tools nip19 if available globally
 */
export function hexToNpub(pubkeyHex: string): string | null {
  if (!isValidPubkey(pubkeyHex)) {
    return null;
  }

  // Try to use nostr-tools if available
  if (typeof globalThis !== 'undefined') {
    const nostrTools = (globalThis as Record<string, unknown>).NostrTools as
      | { nip19?: { npubEncode?: (hex: string) => string } }
      | undefined;

    if (nostrTools?.nip19?.npubEncode) {
      try {
        return nostrTools.nip19.npubEncode(pubkeyHex);
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Detect the type of identifier string
 *
 * @param identifier - Input string (npub, nip05, or hex pubkey)
 * @returns The detected identifier type
 */
export function detectIdentifierType(identifier: string): IdentifierType {
  if (!identifier || typeof identifier !== 'string') {
    return 'unknown';
  }

  const trimmed = identifier.trim().toLowerCase();

  // Check for npub format
  if (isValidNpub(trimmed)) {
    return 'npub';
  }

  // Check for hex pubkey (64 hex chars)
  if (isValidPubkey(trimmed)) {
    return 'pubkeyHex';
  }

  // Check for NIP-05 format (contains @)
  if (trimmed.includes('@') && isValidNip05(identifier)) {
    return 'nip05';
  }

  return 'unknown';
}

/**
 * Get the best display name from a profile
 *
 * @param profile - Nostr profile
 * @returns Best available name or null
 */
export function getBestDisplayName(profile: Profile | null): string | null {
  if (!profile) return null;

  // Prefer displayName
  if (profile.displayName?.trim()) {
    return profile.displayName.trim();
  }

  // Fall back to name
  if (profile.name?.trim()) {
    return profile.name.trim();
  }

  return null;
}

/**
 * Format profile display as a string
 *
 * @param displayInfo - Profile display info
 * @param options - Formatting options
 * @returns Formatted display string
 */
export function formatProfileDisplay(
  displayInfo: ProfileDisplayInfo,
  options: {
    /** Include NIP-05 in output (default true) */
    includeNip05?: boolean;
    /** Fallback text when no name available */
    fallback?: string;
    /** Truncate npub in fallback (default true) */
    truncateNpub?: boolean;
  } = {}
): string {
  const { includeNip05 = true, fallback = 'Unknown', truncateNpub = true } = options;

  let display = '';

  // Try to get display name
  if (displayInfo.displayName) {
    display = displayInfo.displayName;
  } else if (displayInfo.pubkey) {
    // Fallback to truncated pubkey
    if (truncateNpub) {
      const npub = hexToNpub(displayInfo.pubkey);
      if (npub) {
        display = `${npub.slice(0, 12)}...${npub.slice(-4)}`;
      } else {
        display = `${displayInfo.pubkey.slice(0, 8)}...${displayInfo.pubkey.slice(-8)}`;
      }
    } else {
      display = hexToNpub(displayInfo.pubkey) || displayInfo.pubkey;
    }
  } else {
    display = fallback;
  }

  // Append NIP-05 if available
  if (includeNip05 && displayInfo.nip05) {
    display = `${display} (${displayInfo.nip05})`;
  }

  return display;
}

/**
 * ProfileDisplayResolver resolves any identifier to profile display info
 */
export class ProfileDisplayResolver {
  private readonly lookupAdapter: LookupAdapter;
  private readonly nip05Resolver?: (identifier: string) => Promise<{ pubkey: string } | null>;
  private readonly cache?: CacheStore<ProfileDisplayInfo>;
  private readonly pendingRequests = new Map<string, Promise<ProfileDisplayInfo>>();

  constructor(config: ProfileDisplayResolverConfig) {
    this.lookupAdapter = config.lookupAdapter;
    this.nip05Resolver = config.nip05Resolver;
    this.cache = config.cache;
  }

  /**
   * Resolve an identifier to profile display info
   *
   * @param identifier - npub, nip05, or hex pubkey
   * @returns Profile display info
   */
  async resolve(identifier: string): Promise<ProfileDisplayInfo> {
    const trimmed = identifier.trim();
    const cacheKey = `display:${trimmed.toLowerCase()}`;

    // Check cache
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Deduplicate concurrent requests
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) {
      return pending;
    }

    const resolvePromise = this.resolveInternal(trimmed);
    this.pendingRequests.set(cacheKey, resolvePromise);

    try {
      const result = await resolvePromise;

      // Cache the result
      if (this.cache) {
        await this.cache.set(cacheKey, result);
      }

      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  /**
   * Internal resolution logic
   */
  private async resolveInternal(identifier: string): Promise<ProfileDisplayInfo> {
    const identifierType = detectIdentifierType(identifier);

    const baseInfo: ProfileDisplayInfo = {
      identifier,
      identifierType,
      pubkey: null,
      displayName: null,
      nip05: null,
      picture: null,
      profile: null,
    };

    // Resolve to pubkey based on type
    let pubkey: string | null = null;

    switch (identifierType) {
      case 'pubkeyHex':
        pubkey = identifier.toLowerCase();
        break;

      case 'npub':
        pubkey = npubToHex(identifier);
        if (!pubkey) {
          return {
            ...baseInfo,
            error: 'Failed to decode npub',
          };
        }
        break;

      case 'nip05':
        if (this.nip05Resolver) {
          try {
            const resolved = await this.nip05Resolver(identifier);
            pubkey = resolved?.pubkey ?? null;
          } catch (error) {
            return {
              ...baseInfo,
              error: `NIP-05 resolution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };
          }
        }

        if (!pubkey) {
          return {
            ...baseInfo,
            error: 'NIP-05 resolution failed or resolver not configured',
          };
        }
        break;

      case 'unknown':
      default:
        return {
          ...baseInfo,
          error: 'Unknown identifier format',
        };
    }

    // Fetch profile
    baseInfo.pubkey = pubkey;

    try {
      const profile = await this.lookupAdapter.getProfile(pubkey);

      if (profile) {
        return {
          ...baseInfo,
          displayName: getBestDisplayName(profile),
          nip05: profile.nip05 || null,
          picture: profile.picture || null,
          profile,
        };
      }

      // Profile not found but pubkey is valid
      return {
        ...baseInfo,
        error: 'Profile not found',
      };
    } catch (error) {
      return {
        ...baseInfo,
        error: `Failed to fetch profile: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Resolve and format as string
   *
   * @param identifier - npub, nip05, or hex pubkey
   * @param options - Formatting options
   * @returns Formatted display string
   */
  async resolveAndFormat(
    identifier: string,
    options?: Parameters<typeof formatProfileDisplay>[1]
  ): Promise<string> {
    const displayInfo = await this.resolve(identifier);
    return formatProfileDisplay(displayInfo, options);
  }

  /**
   * Batch resolve multiple identifiers
   *
   * @param identifiers - Array of identifiers
   * @returns Map of identifier to display info
   */
  async resolveBatch(identifiers: string[]): Promise<Map<string, ProfileDisplayInfo>> {
    const results = new Map<string, ProfileDisplayInfo>();

    // Resolve all in parallel
    const promises = identifiers.map(async (id) => {
      const result = await this.resolve(id);
      results.set(id, result);
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Clear pending requests
   */
  clearPending(): void {
    this.pendingRequests.clear();
  }
}

/**
 * Create a ProfileDisplayResolver instance
 */
export function createProfileDisplayResolver(
  config: ProfileDisplayResolverConfig
): ProfileDisplayResolver {
  return new ProfileDisplayResolver(config);
}

/**
 * Standalone function to get profile display info
 * This is a convenience function for one-off lookups
 *
 * @param identifier - npub, nip05, or hex pubkey
 * @param lookupAdapter - Profile lookup adapter
 * @param nip05Resolver - Optional NIP-05 resolver
 * @returns Profile display info
 */
export async function getProfileDisplay(
  identifier: string,
  lookupAdapter: LookupAdapter,
  nip05Resolver?: (identifier: string) => Promise<{ pubkey: string } | null>
): Promise<ProfileDisplayInfo> {
  const resolver = new ProfileDisplayResolver({
    lookupAdapter,
    nip05Resolver,
  });
  return resolver.resolve(identifier);
}

/**
 * Standalone function to resolve and format profile display
 *
 * @param identifier - npub, nip05, or hex pubkey
 * @param lookupAdapter - Profile lookup adapter
 * @param nip05Resolver - Optional NIP-05 resolver
 * @param options - Formatting options
 * @returns Formatted display string
 */
export async function resolveProfileDisplay(
  identifier: string,
  lookupAdapter: LookupAdapter,
  nip05Resolver?: (identifier: string) => Promise<{ pubkey: string } | null>,
  options?: Parameters<typeof formatProfileDisplay>[1]
): Promise<string> {
  const displayInfo = await getProfileDisplay(identifier, lookupAdapter, nip05Resolver);
  return formatProfileDisplay(displayInfo, options);
}
