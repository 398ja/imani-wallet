/**
 * TokenParser - Extract and parse Cashu tokens from DM content
 *
 * Parses token transfer messages and extracts metadata.
 */

import type { TokenMetadata } from '../types/dm';

/**
 * Regular expressions for parsing
 */
const TOKEN_PATTERNS = {
  // Cashu token patterns
  cashuA: /cashuA[A-Za-z0-9_-]+/g,
  cashuB: /cashuB[A-Za-z0-9_-]+/g,

  // Token transfer message format
  transferHeader: /🎁\s*Token\s*Transfer:\s*([\d.]+)\s*(\w+)/i,
  backing: /Backing:\s*(MINIMAL|FULL|LEGACY)/i,
  amount: /Amount:\s*([\d.]+)\s*sats?/i,
  memo: /Memo:\s*(.+?)(?:\n|$)/i,
  issuerId: /Issuer:\s*([a-f0-9]{64}|npub[a-z0-9]+)/i,
  voucherId: /Voucher:\s*([a-f0-9-]+)/i,
  ratio: /Ratio:\s*([\d.]+)/i,

  // Spec 012-multi-voucher-send: bundle metadata lines.
  // Per contracts/bundle-metadata-wire-format.md §1.
  bundleId: /Bundle-Id:\s*([0-9a-f]{32})/i,
  bundleTotal: /Bundle-Total:\s*([\d]+)/i,
  bundlePartIndex: /Bundle-Part-Index:\s*([\d]+)/i,
  bundlePartCount: /Bundle-Part-Count:\s*([\d]+)/i,
  bundlePartId: /Bundle-Part-Id:\s*([0-9a-f]{32}:\d+)/i,
  bundleAttempt: /Bundle-Attempt:\s*([\d]+)/i,
};

/**
 * Token parsing utilities
 */
export class TokenParser {
  /**
   * Extract Cashu token from content
   *
   * @param content - DM content
   * @returns Token string if found, null otherwise
   */
  static extractToken(content: string): string | null {
    // Try cashuB first (newer format)
    const cashuBMatch = content.match(TOKEN_PATTERNS.cashuB);
    if (cashuBMatch) {
      return cashuBMatch[0];
    }

    // Fall back to cashuA
    const cashuAMatch = content.match(TOKEN_PATTERNS.cashuA);
    if (cashuAMatch) {
      return cashuAMatch[0];
    }

    return null;
  }

  /**
   * Check if content contains a Cashu token
   */
  static hasToken(content: string): boolean {
    return TOKEN_PATTERNS.cashuA.test(content) || TOKEN_PATTERNS.cashuB.test(content);
  }

  /**
   * Parse token transfer message to extract metadata
   *
   * Expected format:
   * 🎁 Token Transfer: 1.00 USD
   * Backing: MINIMAL | Amount: 69 sats
   * Memo: Hello there!
   *
   * @param content - DM content
   * @returns Token metadata if parseable
   */
  static parseTokenTransferMessage(content: string): TokenMetadata | null {
    // Check for transfer header
    const headerMatch = content.match(TOKEN_PATTERNS.transferHeader);
    if (!headerMatch) {
      // Not a formatted token transfer message
      return TokenParser.parseUnformattedMessage(content);
    }

    const metadata: TokenMetadata = {
      faceValue: parseFloat(headerMatch[1]),
      faceUnit: headerMatch[2].toUpperCase(),
    };

    // Extract backing strategy
    const backingMatch = content.match(TOKEN_PATTERNS.backing);
    if (backingMatch) {
      metadata.backingStrategy = backingMatch[1].toUpperCase() as 'MINIMAL' | 'FULL' | 'LEGACY';
    }

    // Extract token amount in sats
    const amountMatch = content.match(TOKEN_PATTERNS.amount);
    if (amountMatch) {
      metadata.tokenAmount = parseFloat(amountMatch[1]);
    }

    // Extract memo
    const memoMatch = content.match(TOKEN_PATTERNS.memo);
    if (memoMatch) {
      metadata.memo = memoMatch[1].trim();
    }

    // Extract issuer ID
    const issuerMatch = content.match(TOKEN_PATTERNS.issuerId);
    if (issuerMatch) {
      metadata.issuerId = issuerMatch[1];
    }

    // Extract voucher ID
    const voucherMatch = content.match(TOKEN_PATTERNS.voucherId);
    if (voucherMatch) {
      metadata.voucherId = voucherMatch[1];
    }

    // Extract ratio
    const ratioMatch = content.match(TOKEN_PATTERNS.ratio);
    if (ratioMatch) {
      // Store ratio for later use
      const ratio = parseFloat(ratioMatch[1]);
      if (!isNaN(ratio) && ratio > 0) {
        // Calculate face decimals based on ratio if not provided
        if (metadata.tokenAmount && metadata.faceValue) {
          metadata.faceDecimals = TokenParser.inferDecimals(metadata.faceValue);
        }
      }
    }

    // Infer decimals if not set
    if (metadata.faceDecimals === undefined && metadata.faceValue !== undefined) {
      metadata.faceDecimals = TokenParser.inferDecimals(metadata.faceValue);
    }

    // Spec 012-multi-voucher-send: extract bundle metadata if present.
    // Absence of Bundle-Id is the discriminator — receivers must treat that
    // as a standalone send and skip aggregation (per wire-format §4 decision tree).
    const bundleIdMatch = content.match(TOKEN_PATTERNS.bundleId);
    if (bundleIdMatch) {
      metadata.bundleId = bundleIdMatch[1].toLowerCase();
      const totalMatch = content.match(TOKEN_PATTERNS.bundleTotal);
      if (totalMatch) {
        const t = parseInt(totalMatch[1], 10);
        if (Number.isFinite(t)) metadata.bundleTotal = t;
      }
      const idxMatch = content.match(TOKEN_PATTERNS.bundlePartIndex);
      if (idxMatch) {
        const i = parseInt(idxMatch[1], 10);
        if (Number.isFinite(i)) metadata.bundlePartIndex = i;
      }
      const cntMatch = content.match(TOKEN_PATTERNS.bundlePartCount);
      if (cntMatch) {
        const c = parseInt(cntMatch[1], 10);
        if (Number.isFinite(c)) metadata.bundlePartCount = c;
      }
      const partIdMatch = content.match(TOKEN_PATTERNS.bundlePartId);
      if (partIdMatch) {
        metadata.bundlePartId = partIdMatch[1].toLowerCase();
      }
      const attemptMatch = content.match(TOKEN_PATTERNS.bundleAttempt);
      if (attemptMatch) {
        const a = parseInt(attemptMatch[1], 10);
        if (Number.isFinite(a)) metadata.bundleAttempt = a;
      } else {
        // Default to 0 when omitted (per wire-format §1).
        metadata.bundleAttempt = 0;
      }
    }

    return metadata;
  }

  /**
   * Parse unformatted message (just extract any visible metadata)
   */
  private static parseUnformattedMessage(content: string): TokenMetadata | null {
    const metadata: TokenMetadata = {};

    // Try to extract memo from any text before/after token
    const token = TokenParser.extractToken(content);
    if (token) {
      const textWithoutToken = content.replace(token, '').trim();
      if (textWithoutToken) {
        metadata.memo = textWithoutToken.slice(0, 200); // Limit memo length
      }
    }

    // Extract backing strategy if present
    const backingMatch = content.match(TOKEN_PATTERNS.backing);
    if (backingMatch) {
      metadata.backingStrategy = backingMatch[1].toUpperCase() as 'MINIMAL' | 'FULL' | 'LEGACY';
    }

    return Object.keys(metadata).length > 0 ? metadata : null;
  }

  /**
   * Infer decimal places from a number
   */
  private static inferDecimals(value: number): number {
    const str = value.toString();
    const decimalIndex = str.indexOf('.');
    if (decimalIndex === -1) return 0;
    return str.length - decimalIndex - 1;
  }

  /**
   * Generate a fingerprint for a token (for deduplication)
   *
   * @param token - Cashu token string
   * @returns Fingerprint string
   */
  static getTokenFingerprint(token: string): string {
    // Simple fingerprint: first 16 chars of token (after prefix)
    const withoutPrefix = token.replace(/^cashu[AB]/, '');
    return withoutPrefix.substring(0, 16);
  }

  /**
   * Validate token format
   */
  static isValidToken(token: string): boolean {
    return /^cashu[AB][A-Za-z0-9_-]+$/.test(token);
  }

  /**
   * Get token version (A or B)
   */
  static getTokenVersion(token: string): 'A' | 'B' | null {
    if (token.startsWith('cashuA')) return 'A';
    if (token.startsWith('cashuB')) return 'B';
    return null;
  }
}

// Export static methods as standalone functions for convenience
export const extractToken = TokenParser.extractToken;
export const hasToken = TokenParser.hasToken;
export const parseTokenTransferMessage = TokenParser.parseTokenTransferMessage;
export const getTokenFingerprint = TokenParser.getTokenFingerprint;
export const isValidToken = TokenParser.isValidToken;
export const getTokenVersion = TokenParser.getTokenVersion;
