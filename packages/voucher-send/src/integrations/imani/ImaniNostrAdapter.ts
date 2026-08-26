/**
 * ImaniNostrAdapter
 *
 * Adapts the Imani NostrUtils to the NostrAdapter interface.
 * Wraps existing nostr.js functions for use with VoucherSender.
 */

import type { NostrAdapter, ChunkEventOptions, PublishedEvent, Nip60ProofData } from '../../adapters';
import type { Nip05Result, NostrProfile } from '../../types';

/**
 * NostrUtils interface (from shared/nostr.js)
 */
export interface NostrUtilsInterface {
  encodeNpub: (hex: string) => string;
  decodeNpub: (npub: string) => string;
  queryRelayList?: (pubkey: string) => Promise<RelayListResult | null>;
  queryKind0Profile?: (pubkey: string) => Promise<NostrEvent | null>;
  createGiftWrapEvent?: (
    senderPubkey: string,
    senderPrivkey: string | null,
    recipientPubkey: string,
    content: string,
    relays: string[]
  ) => Promise<NostrEvent>;
  publishEvent?: (event: NostrEvent, relays: string[]) => Promise<void>;
}

interface RelayListResult {
  read?: string[];
  write?: string[];
}

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * NIP-60 Publisher interface (from shared/nip60/index.js)
 */
export interface Nip60PublisherInterface {
  isAvailable: () => boolean;
  publishProofsForRecipient: (
    data: { mintUrl: string; proofs: unknown[]; walletDTag?: string },
    recipientPubkey: string
  ) => Promise<void>;
}

/**
 * Fetch function type for NIP-05 resolution
 */
export type FetchFunction = typeof fetch;

/**
 * ImaniNostrAdapter configuration
 */
export interface ImaniNostrAdapterConfig {
  /** NostrUtils object (window.NostrUtils in browser) */
  nostrUtils: NostrUtilsInterface;
  /** Optional NIP-60 publisher */
  nip60Publisher?: Nip60PublisherInterface;
  /** Optional fetch function for NIP-05 resolution */
  fetch?: FetchFunction;
  /** Default NIP-05 domain */
  defaultDomain?: string;
  /** Default relays for publishing */
  defaultRelays?: string[];
}

/**
 * ImaniNostrAdapter
 *
 * Adapts the Imani NostrUtils to the voucher-send NostrAdapter interface.
 */
export class ImaniNostrAdapter implements NostrAdapter {
  private nostrUtils: NostrUtilsInterface;
  private nip60Publisher?: Nip60PublisherInterface;
  private fetchFn: FetchFunction;
  private defaultDomain: string;
  private defaultRelays: string[];

  constructor(config: ImaniNostrAdapterConfig) {
    this.nostrUtils = config.nostrUtils;
    this.nip60Publisher = config.nip60Publisher;
    this.fetchFn = config.fetch ?? fetch;
    this.defaultDomain = config.defaultDomain ?? 'imani.casa';
    this.defaultRelays = config.defaultRelays ?? ['wss://relay.imani.casa'];
  }

  /**
   * Fetch NIP-05 identifier
   */
  async fetchNip05(identifier: string): Promise<Nip05Result> {
    // Parse identifier
    let name: string;
    let domain: string;

    if (identifier.includes('@')) {
      [name, domain] = identifier.split('@');
    } else {
      name = identifier;
      domain = this.defaultDomain;
    }

    try {
      const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
      const response = await this.fetchFn(url);

      if (!response.ok) {
        return {
          success: false,
          error: `NIP-05 resolution failed: ${response.status}`,
        };
      }

      const data = await response.json();
      const pubkey = data.names?.[name] || data.names?.[name.toLowerCase()];

      if (!pubkey) {
        return {
          success: false,
          error: `User "${name}@${domain}" not found`,
        };
      }

      const relays = data.relays?.[pubkey] || [];

      return {
        success: true,
        pubkey,
        relays,
      };
    } catch (error) {
      return {
        success: false,
        error: `NIP-05 resolution failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Query NIP-65 relay list for a pubkey
   */
  async queryRelayList(pubkey: string): Promise<string[]> {
    // Use API if available
    const api = (globalThis as any).nostrApi;
    if (api && typeof api.queryEvents === 'function') {
      try {
        const events = await api.queryEvents({
          kinds: [10002],
          authors: [pubkey],
          limit: 1
        });
        if (events && events.length > 0) {
          const tags = events[0].tags || [];
          const writeRelays = tags
            .filter((t: string[]) => t[0] === 'r' && (!t[2] || t[2] === 'write'))
            .map((t: string[]) => t[1]);
          if (writeRelays.length > 0) return writeRelays;
        }
      } catch (err) {
        console.warn('[ImaniNostrAdapter] API query failed, falling back to NostrUtils:', err);
      }
    }

    if (!this.nostrUtils.queryRelayList) {
      return this.defaultRelays;
    }

    try {
      const result = await this.nostrUtils.queryRelayList(pubkey);
      if (result?.write && result.write.length > 0) {
        return result.write;
      }
      return this.defaultRelays;
    } catch {
      return this.defaultRelays;
    }
  }

  /**
   * Fetch profile for a pubkey
   */
  async fetchProfile(pubkey: string): Promise<NostrProfile | null> {
    // Use API if available
    const api = (globalThis as any).nostrApi;
    if (api && typeof api.getProfile === 'function') {
      try {
        const profile = await api.getProfile(pubkey);
        if (profile) {
          return {
            name: profile.name || profile.display_name,
            about: profile.about,
            picture: profile.picture,
            nip05: profile.nip05,
            lud16: profile.lud16,
            banner: profile.banner,
            website: profile.website,
          };
        }
      } catch (err) {
        console.warn('[ImaniNostrAdapter] API getProfile failed, falling back to NostrUtils:', err);
      }
    }

    if (!this.nostrUtils.queryKind0Profile) {
      return null;
    }

    try {
      const event = await this.nostrUtils.queryKind0Profile(pubkey);
      if (!event) return null;

      const content = JSON.parse(event.content);
      return {
        name: content.name || content.display_name,
        about: content.about,
        picture: content.picture,
        nip05: content.nip05,
        lud16: content.lud16,
        banner: content.banner,
        website: content.website,
      };
    } catch {
      return null;
    }
  }

  /**
   * Publish a chunk event (for large token transfer)
   */
  async publishChunkEvent(_options: ChunkEventOptions): Promise<PublishedEvent> {
    // For now, chunks are published via the API's DM endpoint
    // This is a placeholder for direct relay publishing
    throw new Error('Direct chunk publishing not supported - use API sendTokenDm with chunked content');
  }

  /**
   * Publish NIP-60 proofs for recipient backup
   */
  async publishProofs(data: Nip60ProofData, recipientPubkey: string): Promise<void> {
    if (!this.nip60Publisher?.isAvailable()) {
      return;
    }

    await this.nip60Publisher.publishProofsForRecipient(
      {
        mintUrl: data.mintUrl,
        proofs: data.proofs,
      },
      recipientPubkey
    );
  }

  /**
   * Encode a hex pubkey to npub
   */
  encodeNpub(hex: string): string {
    return this.nostrUtils.encodeNpub(hex);
  }

  /**
   * Decode an npub to hex pubkey
   */
  decodeNpub(npub: string): string {
    return this.nostrUtils.decodeNpub(npub);
  }

  /**
   * Check if NIP-60 publishing is available
   */
  isNip60Available(): boolean {
    return this.nip60Publisher?.isAvailable() ?? false;
  }
}

/**
 * Create an ImaniNostrAdapter from NostrUtils
 *
 * @example
 * // In browser, pass window.NostrUtils
 * const nostr = createImaniNostrAdapter({
 *   nostrUtils: NostrUtils,
 *   nip60Publisher: Nip60Publisher.fromGlobal(pubkey, relays),
 *   defaultDomain: 'imani.casa',
 * });
 */
export function createImaniNostrAdapter(
  config: ImaniNostrAdapterConfig
): ImaniNostrAdapter {
  return new ImaniNostrAdapter(config);
}
