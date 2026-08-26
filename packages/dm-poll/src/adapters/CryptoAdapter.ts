/**
 * CryptoAdapter - Interface for client-side cryptographic operations
 *
 * REQUIRED adapter - Handles NIP-17 gift wrap unwrapping.
 * Private keys NEVER leave the browser.
 */

import type { GiftWrapEvent, UnwrappedDm, TokenMetadata } from '../types/dm';

/**
 * Adapter for client-side cryptographic operations
 *
 * This adapter handles all operations that require access to the
 * user's private key, ensuring it never leaves the browser.
 */
export interface CryptoAdapter {
  /**
   * Unwrap a NIP-17 gift wrap event
   *
   * Decrypts the gift wrap to extract the sealed rumor and
   * then decrypts the rumor to get the actual DM content.
   *
   * @param event - Gift wrap event (kind 1059)
   * @param recipientPrivkey - Recipient's private key (hex)
   * @returns Unwrapped DM if successful, null if decryption fails
   */
  unwrapNip17Dm(
    event: GiftWrapEvent,
    recipientPrivkey: string
  ): Promise<UnwrappedDm | null>;

  /**
   * Parse a token transfer message to extract metadata
   *
   * Parses formatted messages like:
   * "🎁 Token Transfer: 1.00 USD\nBacking: MINIMAL | Amount: 69 sats\nMemo: ..."
   *
   * @param content - DM content to parse
   * @returns Token metadata if content contains a token, null otherwise
   */
  parseTokenTransferMessage(content: string): TokenMetadata | null;

  /**
   * Extract Cashu token from DM content
   *
   * Looks for cashuA... or cashuB... tokens in the content
   *
   * @param content - DM content
   * @returns Token string if found, null otherwise
   */
  extractToken(content: string): string | null;

  /**
   * Generate a fingerprint for deduplication.
   *
   * Implementations may be synchronous (e.g. simple hash over token chars) or
   * asynchronous (e.g. SHA-256 via WebCrypto). Callers must `await` the result
   * — passing a Promise to {@link StorageAdapter.hasTokenBeenReceived} would
   * silently bypass dedup.
   *
   * @param token - Cashu token string
   * @returns Fingerprint string (typically first 16 chars of token hash)
   */
  getTokenFingerprint(token: string): string | Promise<string>;
}

/**
 * Type guard to check if an object implements CryptoAdapter
 */
export function isCryptoAdapter(obj: unknown): obj is CryptoAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const adapter = obj as CryptoAdapter;
  return (
    typeof adapter.unwrapNip17Dm === 'function' &&
    typeof adapter.parseTokenTransferMessage === 'function' &&
    typeof adapter.extractToken === 'function' &&
    typeof adapter.getTokenFingerprint === 'function'
  );
}
