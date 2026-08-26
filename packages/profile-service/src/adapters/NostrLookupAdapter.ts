import type { LookupAdapter } from '../types/adapters.js';
import type { Profile, MerchantProfile } from '../types/profile.js';
import { normalizePubkey, isValidPubkey } from '../utils/validate.js';

/**
 * Nostr event structure (minimal type for dependency injection)
 */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Nostr filter structure
 */
export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  ids?: string[];
  '#d'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

/**
 * Pool interface for relay communication
 * Compatible with nostr-tools SimplePool
 */
export interface NostrPool {
  querySync(relays: string[], filter: NostrFilter): Promise<NostrEvent[]>;
  close?(relays?: string[]): void;
}

/**
 * Configuration for NostrLookupAdapter
 */
export interface NostrLookupAdapterConfig {
  /** Nostr relays to query */
  relays: string[];
  /** Pool instance for relay communication */
  pool: NostrPool;
  /** Timeout for relay queries in ms (default: 5000) */
  timeoutMs?: number;
  /** Kind for merchant profiles (default: 30078) */
  merchantKind?: number;
}

/** Nostr kind for profile metadata */
const KIND_METADATA = 0;
/** Default kind for merchant profiles (NIP-78) */
const DEFAULT_MERCHANT_KIND = 30078;

/**
 * NostrLookupAdapter fetches profiles from Nostr relays
 */
export class NostrLookupAdapter implements LookupAdapter {
  private readonly relays: string[];
  private readonly pool: NostrPool;
  private readonly timeoutMs: number;
  private readonly merchantKind: number;

  constructor(config: NostrLookupAdapterConfig) {
    this.relays = config.relays;
    this.pool = config.pool;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.merchantKind = config.merchantKind ?? DEFAULT_MERCHANT_KIND;
  }

  /**
   * Get a single profile by pubkey
   */
  async getProfile(pubkey: string): Promise<Profile | null> {
    if (!isValidPubkey(pubkey)) {
      return null;
    }

    const normalized = normalizePubkey(pubkey);
    const profiles = await this.fetchProfiles([normalized]);
    return profiles[0] ?? null;
  }

  /**
   * Get multiple profiles by pubkey
   */
  async getProfiles(pubkeys: string[]): Promise<Profile[]> {
    const validPubkeys = pubkeys
      .filter(isValidPubkey)
      .map(normalizePubkey);

    if (validPubkeys.length === 0) {
      return [];
    }

    // Deduplicate
    const uniquePubkeys = [...new Set(validPubkeys)];
    return this.fetchProfiles(uniquePubkeys);
  }

  /**
   * Get merchant profile (kind-30078)
   */
  async getMerchantProfile(pubkey: string): Promise<MerchantProfile | null> {
    if (!isValidPubkey(pubkey)) {
      return null;
    }

    const normalized = normalizePubkey(pubkey);
    const filter: NostrFilter = {
      kinds: [this.merchantKind],
      authors: [normalized],
      '#d': ['merchant-profile'],
      limit: 1,
    };

    const events = await this.queryWithTimeout(filter);
    if (events.length === 0) {
      return null;
    }

    // Get the newest event
    const latest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    return this.parseMerchantProfile(latest);
  }

  /**
   * Close the pool connection
   */
  close(): void {
    if (this.pool.close) {
      this.pool.close(this.relays);
    }
  }

  /**
   * Fetch profiles from relays
   */
  private async fetchProfiles(pubkeys: string[]): Promise<Profile[]> {
    const filter: NostrFilter = {
      kinds: [KIND_METADATA],
      authors: pubkeys,
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

    // Parse profiles
    const profiles: Profile[] = [];
    for (const event of latestByPubkey.values()) {
      const profile = this.parseProfile(event);
      if (profile) {
        profiles.push(profile);
      }
    }

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
        console.warn('[NostrLookupAdapter] API query failed, falling back to relay:', err);
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
   * Parse a kind-30078 event into a MerchantProfile
   */
  private parseMerchantProfile(event: NostrEvent): MerchantProfile | null {
    try {
      const metadata = JSON.parse(event.content) as Record<string, unknown>;

      const merchantProfile: MerchantProfile = {
        pubkey: event.pubkey,
        businessName: this.getString(metadata, 'businessName') ?? this.getString(metadata, 'business_name'),
        businessType: this.getString(metadata, 'businessType') ?? this.getString(metadata, 'business_type'),
        currencies: [],
        createdAt: event.created_at,
        metadata,
      };

      // Extract currencies
      if (metadata.currencies && Array.isArray(metadata.currencies)) {
        merchantProfile.currencies = metadata.currencies.filter(
          (c): c is string => typeof c === 'string'
        );
      }

      // Extract payment methods (support both camelCase and snake_case)
      const paymentMethodsRaw = metadata.paymentMethods ?? metadata.payment_methods;
      if (paymentMethodsRaw && Array.isArray(paymentMethodsRaw)) {
        merchantProfile.paymentMethods = paymentMethodsRaw.filter(
          (m): m is string => typeof m === 'string'
        );
      }

      // Extract location
      if (metadata.location && typeof metadata.location === 'object') {
        const loc = metadata.location as Record<string, unknown>;
        if (typeof loc.lat === 'number' && typeof loc.lon === 'number') {
          merchantProfile.location = {
            lat: loc.lat,
            lon: loc.lon,
            address: this.getString(loc, 'address'),
            country: this.getString(loc, 'country'),
            city: this.getString(loc, 'city'),
          };
        }
      }

      // Extract hours
      if (metadata.hours && typeof metadata.hours === 'object') {
        merchantProfile.hours = metadata.hours as Record<string, string>;
      }

      // Extract verification status
      if (typeof metadata.verified === 'boolean') {
        merchantProfile.verified = metadata.verified;
      }
      if (typeof metadata.verifiedAt === 'number') {
        merchantProfile.verifiedAt = metadata.verifiedAt;
      }

      return merchantProfile;
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
 * Create a NostrLookupAdapter instance
 */
export function createNostrLookupAdapter(config: NostrLookupAdapterConfig): NostrLookupAdapter {
  return new NostrLookupAdapter(config);
}
