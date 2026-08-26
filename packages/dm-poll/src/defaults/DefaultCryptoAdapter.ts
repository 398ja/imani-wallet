/**
 * DefaultCryptoAdapter - Basic crypto adapter implementation
 *
 * Provides default implementations for token parsing.
 * NIP-17 unwrapping must be implemented by the consumer
 * as it requires nostr-tools or similar library.
 */

import type { CryptoAdapter } from '../adapters/CryptoAdapter';
import type { GiftWrapEvent, UnwrappedDm, TokenMetadata } from '../types/dm';
import { TokenParser } from '../processing/TokenParser';

/**
 * Options for DefaultCryptoAdapter
 */
export interface DefaultCryptoAdapterOptions {
  /**
   * Function to unwrap NIP-17 gift wrap events
   * Must be provided as it requires external crypto library
   */
  unwrapNip17Dm?: (
    event: GiftWrapEvent,
    recipientPrivkey: string
  ) => Promise<UnwrappedDm | null>;
}

/**
 * Default crypto adapter with token parsing
 *
 * Note: NIP-17 unwrapping must be provided externally as it
 * requires crypto libraries (nostr-tools).
 */
export class DefaultCryptoAdapter implements CryptoAdapter {
  private readonly unwrapFn: (
    event: GiftWrapEvent,
    recipientPrivkey: string
  ) => Promise<UnwrappedDm | null>;

  constructor(options: DefaultCryptoAdapterOptions = {}) {
    this.unwrapFn = options.unwrapNip17Dm ?? this.defaultUnwrap;
  }

  /**
   * Unwrap a NIP-17 gift wrap event
   */
  async unwrapNip17Dm(
    event: GiftWrapEvent,
    recipientPrivkey: string
  ): Promise<UnwrappedDm | null> {
    return this.unwrapFn(event, recipientPrivkey);
  }

  /**
   * Parse token transfer message
   */
  parseTokenTransferMessage(content: string): TokenMetadata | null {
    return TokenParser.parseTokenTransferMessage(content);
  }

  /**
   * Extract Cashu token from content
   */
  extractToken(content: string): string | null {
    return TokenParser.extractToken(content);
  }

  /**
   * Get token fingerprint
   */
  getTokenFingerprint(token: string): string {
    return TokenParser.getTokenFingerprint(token);
  }

  /**
   * Default unwrap implementation (throws error)
   */
  private async defaultUnwrap(
    _event: GiftWrapEvent,
    _recipientPrivkey: string
  ): Promise<UnwrappedDm | null> {
    throw new Error(
      'NIP-17 unwrapping not configured. ' +
      'Please provide unwrapNip17Dm function in DefaultCryptoAdapter options.'
    );
  }
}

/**
 * Create a DefaultCryptoAdapter
 */
export function createDefaultCryptoAdapter(
  options?: DefaultCryptoAdapterOptions
): DefaultCryptoAdapter {
  return new DefaultCryptoAdapter(options);
}
