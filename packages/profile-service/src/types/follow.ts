/** Merchant discriminator for a followed account (spec 044). */
export type MerchantFlag = 'merchant' | 'customer' | 'unknown';

/** Per-entry convergence state vs the relay (spec 044). */
export type FollowSyncState = 'synced' | 'pending-publish' | 'pending-removal';

/**
 * Follow entry with labels and metadata.
 *
 * The spec-044 fields (`merchant`, `merchantCheckedAt`, `order`, `syncState`,
 * `relayHint`, `petname`, `addedAt`) are optional at the type level for
 * backward compatibility; the LocalFollowAdapter populates them with defaults
 * on read/write so persisted rows always carry a stable shape.
 */
export interface FollowEntry {
  /** Hex pubkey of followed user */
  pubkey: string;
  /** Labels for categorization (e.g., ['merchant', 'favorite']) */
  labels?: string[];
  /** When the follow was created */
  createdAt: number;
  /** Source of the follow entry */
  source: 'local' | 'nostr' | 'api';

  // ---- spec 044: local NIP-02 follow list with merchant discriminator ----
  /** Merchant discriminator. Default 'unknown'; treated as customer for display. */
  merchant?: MerchantFlag;
  /** Epoch ms when `merchant` was last resolved; null = never. Drives TTL refresh. */
  merchantCheckedAt?: number | null;
  /** Epoch ms the follow was added locally (mirrors createdAt for legacy rows). */
  addedAt?: number;
  /** Stable ordering key; remote imports preserve NIP-02 tag order, local adds append. */
  order?: number;
  /** Convergence state vs the relay. */
  syncState?: FollowSyncState;
  /** Optional NIP-02 p-tag relay hint, preserved on import/republish. */
  relayHint?: string | null;
  /** Optional NIP-02 p-tag petname, preserved on import/republish. */
  petname?: string | null;

  // ---- spec 044 (#2): denormalized kind-0 profile snapshot for instant render ----
  /** Cached kind-0 display name, so the followed list renders without a server hit. */
  displayName?: string | null;
  /** Cached kind-0 picture URL. */
  picture?: string | null;
  /** Cached kind-0 nip05 identifier. */
  nip05?: string | null;
  /** Epoch ms when the profile snapshot was last refreshed; null = never. */
  profileUpdatedAt?: number | null;
}

/** A denormalized kind-0 profile snapshot stored on a follow entry (spec 044 #2). */
export interface FollowProfileSnapshot {
  displayName?: string | null;
  picture?: string | null;
  nip05?: string | null;
}

/**
 * Options for adding a follow
 */
export interface AddFollowOptions {
  /** Labels to apply */
  labels?: string[];
  /** Source of the follow */
  source?: FollowEntry['source'];
}

/**
 * Follow list with metadata
 */
export interface FollowList {
  follows: FollowEntry[];
  /** When the list was last synced */
  lastSyncedAt?: number;
  /** Whether there are pending syncs */
  hasPendingSync?: boolean;
}

/**
 * Follow sync status
 */
export interface FollowSyncStatus {
  /** Whether sync is in progress */
  syncing: boolean;
  /** Last successful sync time */
  lastSyncedAt?: number;
  /** Pending changes count */
  pendingChanges: number;
  /** Last sync error if any */
  lastError?: string;
}
