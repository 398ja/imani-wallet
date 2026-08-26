import type { FollowAdapter } from '../types/adapters.js';
import type { NostrPool, NostrFilter, NostrEvent } from './NostrLookupAdapter.js';
import { normalizePubkey, isValidPubkey } from '../utils/validate.js';

/**
 * Unsigned Nostr event for signing
 */
export interface UnsignedNostrEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Signer interface for creating signed events
 */
export interface NostrSigner {
  /** Get the public key */
  getPublicKey(): Promise<string>;
  /** Sign an event */
  signEvent(event: UnsignedNostrEvent): Promise<NostrEvent>;
}

/**
 * Publisher interface for publishing events to relays
 */
export interface NostrPublisher {
  /** Publish an event to relays */
  publish(relays: string[], event: NostrEvent): Promise<void>;
}

/**
 * Configuration for NostrFollowAdapter
 */
export interface NostrFollowAdapterConfig {
  /** Nostr relays to query and publish to */
  relays: string[];
  /** Pool instance for relay communication */
  pool: NostrPool;
  /** Signer for creating contact list events */
  signer: NostrSigner;
  /** Publisher for sending events to relays (optional, defaults to pool) */
  publisher?: NostrPublisher;
  /** Timeout for relay queries in ms (default: 5000) */
  timeoutMs?: number;
  /** Whether to sync to relays on changes (default: true) */
  autoSync?: boolean;
}

/** Nostr kind for contact list */
const KIND_CONTACTS = 3;

/**
 * NostrFollowAdapter syncs follows to/from Nostr kind-3 contact list
 *
 * The kind-3 event stores follows as "p" tags:
 * ["p", "<pubkey>", "<relay-url>", "<petname>"]
 *
 * NIP-02: https://github.com/nostr-protocol/nips/blob/master/02.md (pinned).
 */
export class NostrFollowAdapter implements FollowAdapter {
  private readonly relays: string[];
  private readonly pool: NostrPool;
  private readonly signer: NostrSigner;
  private readonly publisher?: NostrPublisher;
  private readonly timeoutMs: number;
  private readonly autoSync: boolean;

  /** In-memory cache of follows */
  private follows: Set<string> = new Set();
  /** Whether the list has been loaded */
  private loaded = false;
  /** User's pubkey */
  private userPubkey: string | null = null;

  constructor(config: NostrFollowAdapterConfig) {
    this.relays = config.relays;
    this.pool = config.pool;
    this.signer = config.signer;
    this.publisher = config.publisher;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.autoSync = config.autoSync ?? true;
  }

  /**
   * List all followed pubkeys
   */
  async list(): Promise<string[]> {
    await this.ensureLoaded();
    return Array.from(this.follows);
  }

  /**
   * Add a pubkey to follow list
   */
  async add(pubkey: string): Promise<void> {
    if (!isValidPubkey(pubkey)) {
      throw new Error(`Invalid pubkey: ${pubkey}`);
    }

    const normalized = normalizePubkey(pubkey);
    await this.ensureLoaded();

    if (this.follows.has(normalized)) {
      return; // Already following
    }

    this.follows.add(normalized);

    if (this.autoSync) {
      await this.publishContactList();
    }
  }

  /**
   * Remove a pubkey from follow list
   */
  async remove(pubkey: string): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    await this.ensureLoaded();

    if (!this.follows.has(normalized)) {
      return; // Not following
    }

    this.follows.delete(normalized);

    if (this.autoSync) {
      await this.publishContactList();
    }
  }

  /**
   * Clear all follows
   */
  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.follows.clear();

    if (this.autoSync) {
      await this.publishContactList();
    }
  }

  /**
   * Check if following a pubkey
   */
  async has(pubkey: string): Promise<boolean> {
    if (!isValidPubkey(pubkey)) {
      return false;
    }

    const normalized = normalizePubkey(pubkey);
    await this.ensureLoaded();
    return this.follows.has(normalized);
  }

  /**
   * Force refresh from relays
   */
  async refresh(): Promise<void> {
    this.loaded = false;
    await this.ensureLoaded();
  }

  /**
   * Manually sync to relays
   */
  async sync(): Promise<void> {
    await this.publishContactList();
  }

  /**
   * Close the adapter
   */
  close(): void {
    this.follows.clear();
    this.loaded = false;
    this.userPubkey = null;
  }

  /**
   * Ensure the follow list is loaded
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    // Get user's pubkey
    if (!this.userPubkey) {
      this.userPubkey = await this.signer.getPublicKey();
    }

    // Fetch current contact list from relays
    const filter: NostrFilter = {
      kinds: [KIND_CONTACTS],
      authors: [this.userPubkey],
      limit: 1,
    };

    const events = await this.queryWithTimeout(filter);

    if (events.length > 0) {
      // Get the newest event
      const latest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
      this.parseContactList(latest);
    }

    this.loaded = true;
  }

  /**
   * Parse a kind-3 event into follows set
   */
  private parseContactList(event: NostrEvent): void {
    this.follows.clear();

    for (const tag of event.tags) {
      if (tag[0] === 'p' && tag[1] && isValidPubkey(tag[1])) {
        this.follows.add(normalizePubkey(tag[1]));
      }
    }
  }

  /**
   * Publish the current follow list to relays
   */
  private async publishContactList(): Promise<void> {
    if (!this.userPubkey) {
      this.userPubkey = await this.signer.getPublicKey();
    }

    // Build p tags for each follow
    const tags: string[][] = Array.from(this.follows).map((pubkey) => ['p', pubkey]);

    const unsigned: UnsignedNostrEvent = {
      kind: KIND_CONTACTS,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '', // Kind-3 content is typically empty or contains relay preferences
    };

    const signed = await this.signer.signEvent(unsigned);

    // Publish to relays
    if (this.publisher) {
      await this.publisher.publish(this.relays, signed);
    } else {
      // Default: use pool if it has publish capability
      // This is a simplified approach - real implementations would use
      // the pool's publish methods
      throw new Error('Publisher not configured. Provide a publisher in the config.');
    }
  }

  /**
   * Query relays with timeout
   */
  private async queryWithTimeout(filter: NostrFilter): Promise<NostrEvent[]> {
    // Use API if available
    const api = (globalThis as any).nostrApi;
    if (api && typeof api.queryEvents === 'function') {
      try {
        return await api.queryEvents(filter);
      } catch (err) {
        console.warn('[NostrFollowAdapter] API query failed, falling back to relay:', err);
      }
    }

    const timeoutPromise = new Promise<NostrEvent[]>((resolve) => {
      setTimeout(() => resolve([]), this.timeoutMs);
    });

    const queryPromise = this.pool.querySync(this.relays, filter);

    return Promise.race([queryPromise, timeoutPromise]);
  }
}

/**
 * Create a NostrFollowAdapter instance
 */
export function createNostrFollowAdapter(config: NostrFollowAdapterConfig): NostrFollowAdapter {
  return new NostrFollowAdapter(config);
}
