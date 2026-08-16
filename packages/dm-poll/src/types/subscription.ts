/**
 * Subscription-related types
 */

/**
 * Handle for managing an active subscription
 */
export interface SubscriptionHandle {
  /** Unique subscription identifier */
  id: string;

  /** Stop the subscription */
  stop(): void;

  /** Check if subscription is still active */
  isActive(): boolean;
}

/**
 * Event filter for nostrdb queries
 */
export interface EventFilter {
  /** Event kinds to filter */
  kinds?: number[];

  /** Author public keys */
  authors?: string[];

  /** Generic tag filters */
  tags?: Record<string, string[]>;

  /** P-tag filter (recipient pubkeys) */
  pTags?: string[];

  /** Events since timestamp */
  since?: number;

  /** Events until timestamp */
  until?: number;

  /** Maximum number of events */
  limit?: number;
}

/**
 * Nostr event structure (generic)
 */
export interface NostrEvent {
  /** Event ID */
  id: string;

  /** Event kind */
  kind: number;

  /** Author public key */
  pubkey: string;

  /** Creation timestamp */
  created_at: number;

  /** Event tags */
  tags: string[][];

  /** Event content */
  content: string;

  /** Event signature */
  sig: string;
}
