/**
 * RelayDiscovery
 *
 * Discovers relay URLs for a given public key using NIP-65.
 */

import type { NostrAdapter } from '../adapters';

/**
 * Relay list from NIP-65
 */
export interface RelayList {
  /** Read relays */
  read: string[];

  /** Write relays */
  write: string[];

  /** All relays (read + write deduplicated) */
  all: string[];
}

/**
 * RelayDiscovery configuration
 */
export interface RelayDiscoveryConfig {
  /** Default relays to use when none found */
  defaultRelays?: string[];

  /** Infrastructure relay (always included) */
  infraRelay?: string;

  /** Maximum relays to return */
  maxRelays?: number;

  /** Cache TTL in milliseconds */
  cacheTtl?: number;
}

/**
 * Cache entry
 */
interface CacheEntry {
  relays: string[];
  timestamp: number;
}

/**
 * RelayDiscovery
 *
 * Discovers and manages relay lists for recipients.
 */
export class RelayDiscovery {
  private nostrAdapter?: NostrAdapter;
  private defaultRelays: string[];
  private infraRelay?: string;
  private maxRelays: number;
  private cacheTtl: number;
  private cache: Map<string, CacheEntry>;

  constructor(nostrAdapter?: NostrAdapter, config: RelayDiscoveryConfig = {}) {
    this.nostrAdapter = nostrAdapter;
    this.defaultRelays = config.defaultRelays || [];
    this.infraRelay = config.infraRelay;
    this.maxRelays = config.maxRelays || 10;
    this.cacheTtl = config.cacheTtl || 5 * 60 * 1000; // 5 minutes default
    this.cache = new Map();
  }

  /**
   * Get relays for a public key
   *
   * @param pubkeyHex - Hex public key
   * @returns Array of relay URLs
   */
  async getRelays(pubkeyHex: string): Promise<string[]> {
    // Check cache first
    const cached = this.getFromCache(pubkeyHex);
    if (cached) {
      return cached;
    }

    const relays = new Set<string>();

    // Always add infra relay first
    if (this.infraRelay) {
      relays.add(this.infraRelay);
    }

    // Query NIP-65 relays if adapter available
    if (this.nostrAdapter) {
      try {
        const nip65Relays = await this.nostrAdapter.queryRelayList(pubkeyHex);
        for (const relay of nip65Relays) {
          relays.add(relay);
          if (relays.size >= this.maxRelays) break;
        }
      } catch (error) {
        console.warn(`[RelayDiscovery] Failed to query NIP-65 for ${pubkeyHex}:`, error);
      }
    }

    // Add default relays if we don't have enough
    if (relays.size < this.maxRelays) {
      for (const relay of this.defaultRelays) {
        relays.add(relay);
        if (relays.size >= this.maxRelays) break;
      }
    }

    const result = Array.from(relays);

    // Cache the result
    this.setCache(pubkeyHex, result);

    return result;
  }

  /**
   * Get write relays for a public key (for DM delivery)
   */
  async getWriteRelays(pubkeyHex: string): Promise<string[]> {
    return this.getRelays(pubkeyHex);
  }

  /**
   * Build a relay list for sending to a recipient
   * Combines infra relay, recipient's relays, and any custom relays
   */
  async buildRelayList(
    recipientPubkey: string,
    customRelays?: string[]
  ): Promise<string[]> {
    const relays = new Set<string>();

    // Infrastructure relay first
    if (this.infraRelay) {
      relays.add(this.infraRelay);
    }

    // Custom relays
    if (customRelays) {
      for (const relay of customRelays) {
        relays.add(relay);
      }
    }

    // Recipient's NIP-65 relays
    const recipientRelays = await this.getRelays(recipientPubkey);
    for (const relay of recipientRelays) {
      relays.add(relay);
      if (relays.size >= this.maxRelays) break;
    }

    return Array.from(relays).slice(0, this.maxRelays);
  }

  /**
   * Set infrastructure relay
   */
  setInfraRelay(relay: string): void {
    this.infraRelay = relay;
  }

  /**
   * Clear the relay cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get from cache if not expired
   */
  private getFromCache(pubkey: string): string[] | null {
    const entry = this.cache.get(pubkey);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.cacheTtl) {
      this.cache.delete(pubkey);
      return null;
    }

    return entry.relays;
  }

  /**
   * Set cache entry
   */
  private setCache(pubkey: string, relays: string[]): void {
    this.cache.set(pubkey, {
      relays,
      timestamp: Date.now(),
    });
  }
}

/**
 * Create a relay discovery instance
 */
export function createRelayDiscovery(
  nostrAdapter?: NostrAdapter,
  config?: RelayDiscoveryConfig
): RelayDiscovery {
  return new RelayDiscovery(nostrAdapter, config);
}
