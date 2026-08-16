/**
 * GiftWrapProcessor - NIP-17 gift wrap unwrapping
 *
 * Handles client-side decryption of NIP-17 gift wrap events.
 * Private key NEVER leaves the browser.
 */

import type { GiftWrapEvent, UnwrappedDm, TokenDm, TokenMetadata } from '../types/dm';
import type { CryptoAdapter } from '../adapters/CryptoAdapter';

/**
 * Options for GiftWrapProcessor
 */
export interface GiftWrapProcessorOptions {
  /** Crypto adapter for NIP-17 unwrapping */
  cryptoAdapter: CryptoAdapter;

  /** Recipient's private key (hex) */
  recipientPrivkey: string;
}

/**
 * Processor for NIP-17 gift wrap events
 */
export class GiftWrapProcessor {
  private readonly cryptoAdapter: CryptoAdapter;
  private recipientPrivkey: string;

  constructor(options: GiftWrapProcessorOptions) {
    this.cryptoAdapter = options.cryptoAdapter;
    this.recipientPrivkey = options.recipientPrivkey;
  }

  /**
   * Update recipient private key
   */
  setRecipientPrivkey(privkey: string): void {
    this.recipientPrivkey = privkey;
  }

  /**
   * Process a gift wrap event to extract token DM
   *
   * @param event - Gift wrap event (kind 1059)
   * @returns TokenDm if successful, null if no token found or decryption fails
   */
  async process(event: GiftWrapEvent): Promise<TokenDm | null> {
    // Unwrap the gift wrap
    const unwrapped = await this.unwrap(event);
    if (!unwrapped) {
      console.log('[GiftWrapProcessor] Failed to unwrap gift wrap:', event.id.substring(0, 8));
      return null;
    }

    // Extract token from content
    const token = this.cryptoAdapter.extractToken(unwrapped.content);
    if (!token) {
      console.log('[GiftWrapProcessor] No token found in DM:', event.id.substring(0, 8));
      return null;
    }

    // Parse metadata
    const metadata = this.cryptoAdapter.parseTokenTransferMessage(unwrapped.content) ?? {};

    return {
      eventId: event.id,
      senderPubkey: unwrapped.senderPubkey,
      token,
      metadata,
      createdAt: unwrapped.createdAt,
    };
  }

  /**
   * Unwrap a gift wrap event (NIP-17 decryption)
   *
   * @param event - Gift wrap event
   * @returns Unwrapped DM content
   */
  async unwrap(event: GiftWrapEvent): Promise<UnwrappedDm | null> {
    try {
      return await this.cryptoAdapter.unwrapNip17Dm(event, this.recipientPrivkey);
    } catch (error) {
      console.error('[GiftWrapProcessor] Unwrap error:', error);
      return null;
    }
  }

  /**
   * Check if an event is a gift wrap event
   */
  isGiftWrap(event: { kind: number }): boolean {
    return event.kind === 1059;
  }

  /**
   * Extract metadata from unwrapped content without extracting token
   */
  extractMetadata(content: string): TokenMetadata | null {
    return this.cryptoAdapter.parseTokenTransferMessage(content);
  }

  /**
   * Check if content contains a token
   */
  hasToken(content: string): boolean {
    return this.cryptoAdapter.extractToken(content) !== null;
  }

  /**
   * Get token fingerprint for deduplication. Mirrors the CryptoAdapter
   * signature: implementations may be sync or async. Callers must `await`.
   */
  getTokenFingerprint(token: string): string | Promise<string> {
    return this.cryptoAdapter.getTokenFingerprint(token);
  }
}

/**
 * Create a GiftWrapProcessor
 */
export function createGiftWrapProcessor(
  options: GiftWrapProcessorOptions
): GiftWrapProcessor {
  return new GiftWrapProcessor(options);
}
