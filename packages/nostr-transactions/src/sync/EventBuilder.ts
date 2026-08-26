/**
 * EventBuilder - Creates NIP-60 transaction history events (kind 7376)
 *
 * NIP-60 specifies that transaction history events should be:
 * - Kind 7376
 * - Encrypted with NIP-44
 * - Tagged with wallet d-tag reference
 */

import type { Transaction } from '../types';
import type {
  NostrEvent,
  UnsignedEvent,
  NostrSigner,
  CryptoProvider,
  Nip60HistoryContent,
} from './types';
import { NIP60_HISTORY_KIND, transactionToHistoryContent } from './types';

/**
 * Event builder configuration
 */
export interface EventBuilderConfig {
  /** User's public key */
  pubkey: string;
  /** Nostr signer */
  signer: NostrSigner;
  /** Wallet d-tag */
  walletDTag?: string;
  /** Enable encryption (default: true) */
  encryption?: boolean;
  /** Custom crypto provider */
  cryptoProvider?: CryptoProvider;
}

/**
 * Builds NIP-60 transaction history events
 */
export class EventBuilder {
  private pubkey: string;
  private signer: NostrSigner;
  private walletDTag?: string;
  private encryption: boolean;
  private cryptoProvider?: CryptoProvider;

  constructor(config: EventBuilderConfig) {
    this.pubkey = config.pubkey;
    this.signer = config.signer;
    this.walletDTag = config.walletDTag;
    this.encryption = config.encryption ?? true;
    this.cryptoProvider = config.cryptoProvider;
  }

  /**
   * Build a history event from a transaction
   */
  async buildHistoryEvent(tx: Transaction): Promise<NostrEvent> {
    const content = transactionToHistoryContent(tx);
    const contentStr = JSON.stringify(content);

    // Encrypt if enabled
    const encryptedContent = this.encryption
      ? await this.encrypt(contentStr)
      : contentStr;

    // Build tags
    const tags: string[][] = [];

    // Add wallet reference tag if available
    if (this.walletDTag) {
      tags.push(['a', `37375:${this.pubkey}:${this.walletDTag}`]);
    }

    // Add transaction ID tag for deduplication
    tags.push(['d', tx.id]);

    // Add timestamp tag
    tags.push(['created_at', String(tx.timestamp)]);

    // Add type tag for filtering
    tags.push(['type', tx.type]);

    // Add direction tag for filtering
    tags.push(['direction', tx.direction]);

    // Create unsigned event
    const unsignedEvent: UnsignedEvent = {
      pubkey: this.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: NIP60_HISTORY_KIND,
      tags,
      content: encryptedContent,
    };

    // Sign the event
    return this.signer.signEvent(unsignedEvent);
  }

  /**
   * Build multiple history events
   */
  async buildHistoryEvents(transactions: Transaction[]): Promise<NostrEvent[]> {
    const events: NostrEvent[] = [];
    for (const tx of transactions) {
      const event = await this.buildHistoryEvent(tx);
      events.push(event);
    }
    return events;
  }

  /**
   * Parse a history event back to transaction content
   */
  async parseHistoryEvent(event: NostrEvent): Promise<Nip60HistoryContent | null> {
    try {
      // Decrypt if encrypted
      const contentStr = this.encryption
        ? await this.decrypt(event.content)
        : event.content;

      return JSON.parse(contentStr) as Nip60HistoryContent;
    } catch (error) {
      console.error('Failed to parse history event:', error);
      return null;
    }
  }

  /**
   * Extract transaction ID from event tags
   */
  getTransactionIdFromEvent(event: NostrEvent): string | null {
    const dTag = event.tags.find((t) => t[0] === 'd');
    return dTag ? dTag[1] : null;
  }

  /**
   * Extract wallet d-tag from event tags
   */
  getWalletDTagFromEvent(event: NostrEvent): string | null {
    const aTag = event.tags.find((t) => t[0] === 'a');
    if (!aTag) return null;

    // Format: 37375:pubkey:d-tag
    const parts = aTag[1].split(':');
    return parts.length >= 3 ? parts[2] : null;
  }

  /**
   * Check if an event is a valid NIP-60 history event
   */
  isValidHistoryEvent(event: NostrEvent): boolean {
    return (
      event.kind === NIP60_HISTORY_KIND &&
      event.pubkey === this.pubkey &&
      typeof event.content === 'string' &&
      event.content.length > 0
    );
  }

  /**
   * Update configuration
   */
  setWalletDTag(dTag: string): void {
    this.walletDTag = dTag;
  }

  // ==================== Private Helpers ====================

  /**
   * Encrypt content using NIP-44
   */
  private async encrypt(plaintext: string): Promise<string> {
    if (this.cryptoProvider) {
      return this.cryptoProvider.encrypt(this.pubkey, plaintext);
    }

    if (this.signer.nip44) {
      return this.signer.nip44.encrypt(this.pubkey, plaintext);
    }

    // Fallback to NIP-04 if NIP-44 not available
    if (this.signer.nip04) {
      return this.signer.nip04.encrypt(this.pubkey, plaintext);
    }

    throw new Error('No encryption provider available');
  }

  /**
   * Decrypt content using NIP-44
   */
  private async decrypt(ciphertext: string): Promise<string> {
    if (this.cryptoProvider) {
      return this.cryptoProvider.decrypt(this.pubkey, ciphertext);
    }

    if (this.signer.nip44) {
      return this.signer.nip44.decrypt(this.pubkey, ciphertext);
    }

    // Fallback to NIP-04 if NIP-44 not available
    if (this.signer.nip04) {
      return this.signer.nip04.decrypt(this.pubkey, ciphertext);
    }

    throw new Error('No decryption provider available');
  }
}

/**
 * Create an event builder
 */
export function createEventBuilder(config: EventBuilderConfig): EventBuilder {
  return new EventBuilder(config);
}
