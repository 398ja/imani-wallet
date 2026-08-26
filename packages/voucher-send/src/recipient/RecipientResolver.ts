/**
 * RecipientResolver
 *
 * Main orchestrator for resolving recipient information.
 * Combines NIP-05 resolution, relay discovery, and profile fetching.
 */

import type { ApiAdapter, NostrAdapter } from '../adapters';
import type { Recipient, RecipientInput } from '../types';
import { VoucherSendError, ErrorCodes } from '../core/errors';
import { Nip05Resolver, type Nip05ResolverConfig } from './Nip05Resolver';
import { RelayDiscovery, type RelayDiscoveryConfig } from './RelayDiscovery';
import { ProfileFetcher, type ProfileFetcherConfig } from './ProfileFetcher';

/**
 * RecipientResolver configuration
 */
export interface RecipientResolverConfig {
  /** NIP-05 resolver config */
  nip05?: Nip05ResolverConfig;

  /** Relay discovery config */
  relay?: RelayDiscoveryConfig;

  /** Profile fetcher config */
  profile?: ProfileFetcherConfig;

  /** Whether to fetch profile (default: true) */
  fetchProfile?: boolean;

  /** Whether to fetch relays (default: true) */
  fetchRelays?: boolean;
}

/**
 * Resolve options for individual resolution
 */
export interface ResolveOptions {
  /** Whether to fetch profile */
  fetchProfile?: boolean;

  /** Whether to fetch relays */
  fetchRelays?: boolean;

  /** Fallback display name */
  fallbackName?: string;
}

/**
 * Check if string is hex pubkey (64 hex chars)
 */
function isHexPubkey(str: string): boolean {
  return /^[0-9a-f]{64}$/i.test(str);
}

/**
 * Check if string is npub (bech32 encoded)
 */
function isNpub(str: string): boolean {
  return str.startsWith('npub1') && str.length >= 59;
}

/**
 * Decode npub to hex
 * Simple implementation - for full support use nostr-tools
 */
function decodeNpub(_npub: string): string | null {
  // This is a simplified decoder
  // In production, use nostr-tools nip19.decode()
  // For now, we'll just return null and let the adapter handle it
  return null;
}

/**
 * Encode hex to npub
 * Simple implementation - for full support use nostr-tools
 */
function encodeNpub(hex: string): string {
  // This is a simplified encoder
  // In production, use nostr-tools nip19.encode()
  // For now, return a placeholder
  return `npub1${hex.slice(0, 58)}`;
}

/**
 * RecipientResolver
 *
 * Resolves recipient identifiers to full recipient objects.
 */
export class RecipientResolver {
  private nip05Resolver: Nip05Resolver;
  private relayDiscovery: RelayDiscovery;
  private profileFetcher: ProfileFetcher;
  private fetchProfileDefault: boolean;
  private fetchRelaysDefault: boolean;

  constructor(
    apiAdapter?: ApiAdapter,
    nostrAdapter?: NostrAdapter,
    config: RecipientResolverConfig = {}
  ) {
    this.nip05Resolver = new Nip05Resolver(nostrAdapter, config.nip05);
    this.relayDiscovery = new RelayDiscovery(nostrAdapter, config.relay);
    this.profileFetcher = new ProfileFetcher(apiAdapter, config.profile);
    this.fetchProfileDefault = config.fetchProfile ?? true;
    this.fetchRelaysDefault = config.fetchRelays ?? true;
  }

  /**
   * Resolve a recipient from various input formats
   *
   * @param input - npub, hex pubkey, NIP-05 identifier, or Recipient object
   * @param options - Resolution options
   * @returns Resolved recipient
   */
  async resolve(input: RecipientInput, options: ResolveOptions = {}): Promise<Recipient> {
    const fetchProfile = options.fetchProfile ?? this.fetchProfileDefault;
    const fetchRelays = options.fetchRelays ?? this.fetchRelaysDefault;

    // Already a Recipient object
    if (typeof input === 'object' && 'pubkeyHex' in input) {
      return this.enrichRecipient(input, { fetchProfile, fetchRelays });
    }

    // String input - detect format
    const identifier = input.trim();

    // Hex pubkey
    if (isHexPubkey(identifier)) {
      return this.resolveFromHex(identifier, { fetchProfile, fetchRelays });
    }

    // npub
    if (isNpub(identifier)) {
      return this.resolveFromNpub(identifier, { fetchProfile, fetchRelays });
    }

    // NIP-05 (or bare username)
    return this.resolveFromNip05(identifier, { fetchProfile, fetchRelays, fallbackName: options.fallbackName });
  }

  /**
   * Resolve from hex public key
   */
  async resolveFromHex(
    pubkeyHex: string,
    options: ResolveOptions = {}
  ): Promise<Recipient> {
    const recipient: Recipient = {
      pubkeyHex: pubkeyHex.toLowerCase(),
      npub: encodeNpub(pubkeyHex.toLowerCase()),
      relays: [],
    };

    return this.enrichRecipient(recipient, options);
  }

  /**
   * Resolve from npub
   */
  async resolveFromNpub(
    npub: string,
    options: ResolveOptions = {}
  ): Promise<Recipient> {
    // Try to decode npub to hex
    const hex = decodeNpub(npub);

    if (!hex) {
      // Can't decode locally - store npub and let API handle it
      // This is a limitation without nostr-tools
      throw new VoucherSendError(
        'Cannot decode npub. Use NIP-05 identifier instead.',
        ErrorCodes.INVALID_RECIPIENT,
        { npub }
      );
    }

    const recipient: Recipient = {
      pubkeyHex: hex,
      npub,
      relays: [],
    };

    return this.enrichRecipient(recipient, options);
  }

  /**
   * Resolve from NIP-05 identifier
   */
  async resolveFromNip05(
    nip05: string,
    options: ResolveOptions = {}
  ): Promise<Recipient> {
    // Resolve NIP-05 to pubkey
    const result = await this.nip05Resolver.resolveOrThrow(nip05);

    const recipient: Recipient = {
      pubkeyHex: result.pubkey,
      npub: encodeNpub(result.pubkey),
      nip05: this.nip05Resolver.normalize(nip05),
      relays: result.relays,
    };

    // Extract username as fallback name
    const username = recipient.nip05?.split('@')[0];
    const fallbackName = options.fallbackName || username;

    return this.enrichRecipient(recipient, { ...options, fallbackName });
  }

  /**
   * Enrich recipient with profile and relay data
   */
  private async enrichRecipient(
    recipient: Recipient,
    options: ResolveOptions
  ): Promise<Recipient> {
    const tasks: Promise<void>[] = [];

    // Fetch relays if needed
    if (options.fetchRelays && recipient.relays.length === 0) {
      tasks.push(
        this.relayDiscovery.getRelays(recipient.pubkeyHex).then((relays) => {
          recipient.relays = relays;
        }).catch(() => {
          // Non-fatal - continue without relays
        })
      );
    }

    // Fetch profile if needed
    if (options.fetchProfile && !recipient.displayName) {
      tasks.push(
        this.profileFetcher.fetch(recipient.pubkeyHex).then((result) => {
          if (result.success) {
            recipient.displayName = result.displayName || options.fallbackName;
            recipient.picture = result.picture;
          } else {
            recipient.displayName = options.fallbackName;
          }
        }).catch(() => {
          recipient.displayName = options.fallbackName;
        })
      );
    }

    // Wait for all enrichment
    await Promise.all(tasks);

    return recipient;
  }

  /**
   * Validate that a recipient can receive tokens
   */
  validate(recipient: Recipient): { valid: boolean; error?: string } {
    if (!recipient.pubkeyHex) {
      return { valid: false, error: 'Missing public key' };
    }

    if (!isHexPubkey(recipient.pubkeyHex)) {
      return { valid: false, error: 'Invalid public key format' };
    }

    return { valid: true };
  }

  /**
   * Check if input looks like a valid recipient identifier
   */
  isValidInput(input: string): boolean {
    const trimmed = input.trim();
    return isHexPubkey(trimmed) || isNpub(trimmed) || this.nip05Resolver.isValid(trimmed);
  }

  /**
   * Get the NIP-05 resolver for direct access
   */
  getNip05Resolver(): Nip05Resolver {
    return this.nip05Resolver;
  }

  /**
   * Get the relay discovery for direct access
   */
  getRelayDiscovery(): RelayDiscovery {
    return this.relayDiscovery;
  }

  /**
   * Get the profile fetcher for direct access
   */
  getProfileFetcher(): ProfileFetcher {
    return this.profileFetcher;
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.relayDiscovery.clearCache();
    this.profileFetcher.clearCache();
  }
}

/**
 * Create a recipient resolver instance
 */
export function createRecipientResolver(
  apiAdapter?: ApiAdapter,
  nostrAdapter?: NostrAdapter,
  config?: RecipientResolverConfig
): RecipientResolver {
  return new RecipientResolver(apiAdapter, nostrAdapter, config);
}
