/**
 * TokenChunker
 *
 * Handles chunking of large tokens for Nostr relay transmission.
 *
 * Nostr relays impose size limits:
 * - strfry default: maxEventSize = 65536 (64KB)
 * - NIP-44 encryption adds ~33% overhead
 * - A 50KB token becomes ~67KB after encryption → exceeds limit
 */

import type { NostrAdapter } from '../adapters';
import type { ChunkProgress } from '../types';

/**
 * Default chunk threshold (40KB - safe under 64KB after encryption)
 */
export const CHUNK_THRESHOLD = 40_000;

/**
 * Default chunk size (30KB per chunk)
 */
export const CHUNK_SIZE = 30_000;

/**
 * Chunk data structure
 */
export interface ChunkData {
  /** Chunk index (0-based) */
  index: number;

  /** Total number of chunks */
  total: number;

  /** Chunk content */
  data: string;
}

/**
 * Chunk reference for DM payload
 */
export interface ChunkReference {
  /** Type identifier */
  type: 'cashu:chunk';

  /** Event ID of first chunk */
  eventId: string;

  /** Author pubkey (sender) */
  author?: string;

  /** Relay hints */
  relays: string[];

  /** Number of chunks */
  chunkCount: number;
}

/**
 * TokenChunker configuration
 */
export interface TokenChunkerConfig {
  /** Size threshold for chunking (bytes) */
  chunkThreshold?: number;

  /** Size per chunk (bytes) */
  chunkSize?: number;

  /** Encryption overhead multiplier */
  encryptionOverhead?: number;
}

/**
 * Publish chunked options
 */
export interface PublishChunkedOptions {
  /** Sender pubkey for author field */
  senderPubkey?: string;

  /** Progress callback */
  onProgress?: (progress: ChunkProgress) => void;
}

/**
 * TokenChunker
 *
 * Splits large tokens into chunks for Nostr transmission.
 */
export class TokenChunker {
  private nostrAdapter?: NostrAdapter;
  private chunkThreshold: number;
  private chunkSize: number;
  private encryptionOverhead: number;

  constructor(nostrAdapter?: NostrAdapter, config: TokenChunkerConfig = {}) {
    this.nostrAdapter = nostrAdapter;
    this.chunkThreshold = config.chunkThreshold ?? CHUNK_THRESHOLD;
    this.chunkSize = config.chunkSize ?? CHUNK_SIZE;
    this.encryptionOverhead = config.encryptionOverhead ?? 1.4;
  }

  /**
   * Check if token needs chunking based on estimated encrypted size
   */
  needsChunking(token: string): boolean {
    const estimatedSize = token.length * this.encryptionOverhead;
    return estimatedSize > this.chunkThreshold;
  }

  /**
   * Get estimated size after encryption
   */
  getEstimatedSize(token: string): number {
    return Math.ceil(token.length * this.encryptionOverhead);
  }

  /**
   * Calculate number of chunks needed
   */
  getChunkCount(token: string): number {
    if (!this.needsChunking(token)) {
      return 1;
    }
    return Math.ceil(token.length / this.chunkSize);
  }

  /**
   * Create chunks from token
   */
  createChunks(token: string): ChunkData[] {
    const chunks: ChunkData[] = [];
    const total = Math.ceil(token.length / this.chunkSize);

    for (let i = 0; i < token.length; i += this.chunkSize) {
      chunks.push({
        index: chunks.length,
        total,
        data: token.slice(i, i + this.chunkSize),
      });
    }

    return chunks;
  }

  /**
   * Publish chunked token to relays
   *
   * @param token - Token to chunk and publish
   * @param recipientPubkey - Recipient's hex pubkey
   * @param relays - Relay URLs to publish to
   * @param options - Additional options
   * @returns Chunk reference for DM
   */
  async publishChunked(
    token: string,
    recipientPubkey: string,
    relays: string[],
    options: PublishChunkedOptions = {}
  ): Promise<ChunkReference> {
    if (!this.nostrAdapter?.publishChunkEvent) {
      throw new Error('NostrAdapter does not support chunk publishing');
    }

    const chunks = this.createChunks(token);
    const eventIds: string[] = [];
    const dTagBase = `cashu-token-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    for (const chunk of chunks) {
      const event = await this.nostrAdapter.publishChunkEvent({
        kind: 4, // Encrypted DM kind
        dTag: `${dTagBase}-${chunk.index}`,
        recipient: recipientPubkey,
        content: chunk.data,
        tags: [
          ['chunk', String(chunk.index), String(chunk.total)],
          ['p', recipientPubkey],
        ],
        relays,
      });

      eventIds.push(event.id);

      // Report progress
      options.onProgress?.({
        published: chunk.index + 1,
        total: chunk.total,
      });
    }

    return {
      type: 'cashu:chunk',
      eventId: eventIds[0]!,
      author: options.senderPubkey,
      relays,
      chunkCount: chunks.length,
    };
  }

  /**
   * Reassemble chunks into original token
   * (For testing/verification purposes)
   */
  reassemble(chunks: ChunkData[]): string {
    // Sort by index
    const sorted = [...chunks].sort((a, b) => a.index - b.index);

    // Verify completeness
    if (sorted.length === 0) {
      throw new Error('No chunks provided');
    }

    const total = sorted[0]!.total;
    if (sorted.length !== total) {
      throw new Error(`Missing chunks: have ${sorted.length}, expected ${total}`);
    }

    // Verify indices
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i]!.index !== i) {
        throw new Error(`Missing chunk at index ${i}`);
      }
    }

    return sorted.map((c) => c.data).join('');
  }
}

/**
 * Create a token chunker instance
 */
export function createTokenChunker(
  nostrAdapter?: NostrAdapter,
  config?: TokenChunkerConfig
): TokenChunker {
  return new TokenChunker(nostrAdapter, config);
}
