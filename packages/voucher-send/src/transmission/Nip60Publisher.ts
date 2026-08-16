/**
 * Nip60Publisher
 *
 * Publishes proofs to NIP-60 relays for recipient backup.
 * This is a best-effort feature - failures are non-fatal.
 */

import type { NostrAdapter, Nip60ProofData } from '../adapters';

/**
 * Cashu proof structure
 */
export interface CashuProof {
  /** Proof amount */
  amount: number;

  /** Proof ID */
  id: string;

  /** Secret */
  secret: string;

  /** Signature (C) */
  C: string;
}

/**
 * Token entry from decoded Cashu token
 */
export interface TokenEntry {
  /** Mint URL */
  mint: string;

  /** Proofs */
  proofs: CashuProof[];
}

/**
 * Decoded Cashu token structure
 */
export interface DecodedToken {
  /** Token entries */
  token: TokenEntry[];

  /** Optional memo */
  memo?: string;
}

/**
 * Nip60Publisher configuration
 */
export interface Nip60PublisherConfig {
  /** NIP-60 relay URLs */
  relays?: string[];

  /** Default wallet d-tag */
  defaultWalletDTag?: string;

  /** Sender pubkey for signing */
  senderPubkey?: string;
}

/**
 * Publish options
 */
export interface PublishOptions {
  /** Mint URL */
  mintUrl: string;

  /** Proofs to publish */
  proofs: CashuProof[];

  /** Wallet d-tag */
  walletDTag?: string;

  /** Event ID reference */
  eventId?: string;
}

/**
 * Publish result
 */
export interface PublishResult {
  /** Whether publish was successful */
  success: boolean;

  /** Error message if failed */
  error?: string;

  /** Number of proofs published */
  proofCount?: number;
}

/**
 * Nip60Publisher
 *
 * Publishes Cashu proofs to NIP-60 relays for recipient wallet backup.
 */
export class Nip60Publisher {
  private nostrAdapter?: NostrAdapter;
  private relays: string[];
  private defaultWalletDTag: string;

  constructor(nostrAdapter?: NostrAdapter, config: Nip60PublisherConfig = {}) {
    this.nostrAdapter = nostrAdapter;
    this.relays = config.relays || [];
    this.defaultWalletDTag = config.defaultWalletDTag || 'default';
  }

  /**
   * Check if NIP-60 publishing is available
   */
  isAvailable(): boolean {
    return !!this.nostrAdapter && this.relays.length > 0;
  }

  /**
   * Set NIP-60 relays
   */
  setRelays(relays: string[]): void {
    this.relays = relays;
  }


  /**
   * Publish proofs for a recipient
   *
   * @param options - Publish options
   * @param recipientPubkey - Recipient's hex pubkey
   * @returns Publish result
   */
  async publishProofsForRecipient(
    options: PublishOptions,
    recipientPubkey: string
  ): Promise<PublishResult> {
    if (!this.isAvailable()) {
      return {
        success: false,
        error: 'NIP-60 publishing not available',
      };
    }

    if (!options.proofs || options.proofs.length === 0) {
      return {
        success: false,
        error: 'No proofs to publish',
      };
    }

    try {
      const proofData: Nip60ProofData = {
        proofs: options.proofs,
        mintUrl: options.mintUrl,
        eventId: options.eventId,
      };

      await this.nostrAdapter!.publishProofs(proofData, recipientPubkey);

      return {
        success: true,
        proofCount: options.proofs.length,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Publish proofs from a decoded token
   *
   * @param decodedToken - Decoded Cashu token
   * @param recipientPubkey - Recipient's hex pubkey
   * @returns Publish result
   */
  async publishFromDecodedToken(
    decodedToken: DecodedToken,
    recipientPubkey: string
  ): Promise<PublishResult> {
    if (!decodedToken.token || decodedToken.token.length === 0) {
      return {
        success: false,
        error: 'Token has no entries',
      };
    }

    const tokenEntry = decodedToken.token[0]!;

    return this.publishProofsForRecipient(
      {
        mintUrl: tokenEntry.mint,
        proofs: tokenEntry.proofs,
        walletDTag: this.defaultWalletDTag,
      },
      recipientPubkey
    );
  }

  /**
   * Extract proofs from a Cashu token string
   * Note: This is a simplified parser. For production, use @cashu/cashu-ts
   */
  extractProofsFromToken(token: string): {
    mintUrl: string;
    proofs: CashuProof[];
  } | null {
    try {
      // Handle cashuA (base64url) tokens
      if (token.startsWith('cashuA')) {
        const base64 = token.slice(6);
        const decoded = this.decodeBase64Url(base64);
        const parsed = JSON.parse(decoded);

        if (parsed.token && parsed.token.length > 0) {
          const entry = parsed.token[0];
          return {
            mintUrl: entry.mint || '',
            proofs: entry.proofs || [],
          };
        }
      }

      // Handle cashuB (CBOR) tokens - not implemented
      if (token.startsWith('cashuB')) {
        console.warn('[Nip60Publisher] cashuB tokens not supported');
        return null;
      }

      return null;
    } catch (error) {
      console.warn('[Nip60Publisher] Failed to extract proofs:', error);
      return null;
    }
  }

  /**
   * Publish proofs directly from a token string
   */
  async publishFromToken(
    token: string,
    recipientPubkey: string
  ): Promise<PublishResult> {
    const extracted = this.extractProofsFromToken(token);

    if (!extracted) {
      return {
        success: false,
        error: 'Could not extract proofs from token',
      };
    }

    return this.publishProofsForRecipient(
      {
        mintUrl: extracted.mintUrl,
        proofs: extracted.proofs,
        walletDTag: this.defaultWalletDTag,
      },
      recipientPubkey
    );
  }

  /**
   * Decode base64url string
   */
  private decodeBase64Url(str: string): string {
    // Convert base64url to base64
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');

    // Add padding if needed
    const padding = 4 - (base64.length % 4);
    if (padding !== 4) {
      base64 += '='.repeat(padding);
    }

    // Decode
    if (typeof atob !== 'undefined') {
      return atob(base64);
    }

    // Node.js fallback
    return Buffer.from(base64, 'base64').toString('utf-8');
  }
}

/**
 * Create a NIP-60 publisher instance
 */
export function createNip60Publisher(
  nostrAdapter?: NostrAdapter,
  config?: Nip60PublisherConfig
): Nip60Publisher {
  return new Nip60Publisher(nostrAdapter, config);
}
