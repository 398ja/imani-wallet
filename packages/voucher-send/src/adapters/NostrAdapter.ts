/**
 * Nostr Adapter Interface
 *
 * Defines the interface for Nostr operations.
 * Implementations handle relay connections, NIP-05, and event publishing.
 */

import type { Nip05Result } from '../types';

/**
 * Chunk event options
 */
export interface ChunkEventOptions {
  /** Event kind */
  kind: number;

  /** d tag for replaceable events */
  dTag: string;

  /** Recipient pubkey */
  recipient: string;

  /** Chunk content */
  content: string;

  /** Additional tags */
  tags: string[][];

  /** Relay URLs to publish to */
  relays: string[];
}

/**
 * Published event result
 */
export interface PublishedEvent {
  /** Event ID */
  id: string;

  /** Event kind */
  kind: number;

  /** Pubkey that signed */
  pubkey: string;

  /** Created at timestamp */
  created_at: number;
}

/**
 * NIP-60 proof data
 */
export interface Nip60ProofData {
  /** Cashu proofs */
  proofs: unknown[];

  /** Mint URL */
  mintUrl: string;

  /** Optional event ID reference */
  eventId?: string;
}

/**
 * Nostr Adapter Interface
 *
 * Implementations of this interface handle Nostr protocol operations.
 */
export interface NostrAdapter {
  /**
   * Query a user's relay list (NIP-65)
   *
   * @param pubkey - Hex public key
   * @returns Array of relay URLs
   */
  queryRelayList(pubkey: string): Promise<string[]>;

  /**
   * Resolve a NIP-05 identifier
   *
   * @param identifier - NIP-05 identifier (user@domain)
   * @returns Resolution result
   */
  fetchNip05(identifier: string): Promise<Nip05Result>;

  /**
   * Publish proofs to recipient's NIP-60 backup
   *
   * @param proofs - Proof data to publish
   * @param recipientPubkey - Recipient's hex public key
   */
  publishProofs(proofs: Nip60ProofData, recipientPubkey: string): Promise<void>;

  /**
   * Publish a chunk event (for large token chunking)
   *
   * @param options - Chunk event options
   * @returns Published event info
   */
  publishChunkEvent?(options: ChunkEventOptions): Promise<PublishedEvent>;

  /**
   * Connect to relays
   *
   * @param urls - Relay URLs to connect to
   */
  connectRelays?(urls: string[]): Promise<void>;

  /**
   * Disconnect from relays
   */
  disconnectRelays?(): Promise<void>;
}

/**
 * Type guard to check if an object implements NostrAdapter
 */
export function isNostrAdapter(obj: unknown): obj is NostrAdapter {
  if (typeof obj !== 'object' || obj === null) return false;
  const adapter = obj as Partial<NostrAdapter>;
  return (
    typeof adapter.queryRelayList === 'function' &&
    typeof adapter.fetchNip05 === 'function' &&
    typeof adapter.publishProofs === 'function'
  );
}
