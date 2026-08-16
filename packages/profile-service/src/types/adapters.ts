import type { Profile, MerchantProfile } from './profile.js';
import type { ProfileFilter, ProfileSearchResult } from './filters.js';
import type { FollowEntry, FollowProfileSnapshot, MerchantFlag, FollowSyncState } from './follow.js';

/**
 * Directory adapter for searching profiles
 */
export interface DirectoryAdapter {
  /**
   * Search for profiles matching the filter
   * @param filter - Search filter options
   */
  search(filter: ProfileFilter): Promise<ProfileSearchResult>;

  /**
   * Optional: Get search suggestions
   * @param query - Partial query string
   */
  suggest?(query: string): Promise<string[]>;
}

/**
 * Lookup adapter for fetching individual profiles
 */
export interface LookupAdapter {
  /**
   * Get a single profile by pubkey
   * @param pubkey - Hex pubkey
   */
  getProfile(pubkey: string): Promise<Profile | null>;

  /**
   * Get multiple profiles by pubkey
   * @param pubkeys - Array of hex pubkeys
   */
  getProfiles(pubkeys: string[]): Promise<Profile[]>;

  /**
   * Optional: Get merchant profile
   * @param pubkey - Hex pubkey
   */
  getMerchantProfile?(pubkey: string): Promise<MerchantProfile | null>;
}

/**
 * Follow adapter for managing follow list
 */
export interface FollowAdapter {
  /**
   * List all followed pubkeys
   */
  list(): Promise<string[]>;

  /**
   * Add a pubkey to follow list. `opts` is optional (spec 044): the importer /
   * sync coordinator may pass merchant status, ordering, sync state, and
   * preserved NIP-02 metadata. Implementers that don't need it may ignore it.
   * @param pubkey - Hex pubkey to follow
   */
  add(pubkey: string, opts?: AddFollowEntryOptions): Promise<void>;

  /**
   * Remove a pubkey from follow list
   * @param pubkey - Hex pubkey to unfollow
   */
  remove(pubkey: string): Promise<void>;

  /**
   * Optional: Clear all follows
   */
  clear?(): Promise<void>;

  /**
   * Optional: Check if following a pubkey
   * @param pubkey - Hex pubkey
   */
  has?(pubkey: string): Promise<boolean>;

  /** Optional: get a full follow entry (spec 044). */
  getEntry?(pubkey: string): Promise<FollowEntry | null>;

  /** Optional: list full follow entries (spec 044). */
  listEntries?(): Promise<FollowEntry[]>;

  /** Optional: set the merchant discriminator for an entry (spec 044). */
  setMerchant?(pubkey: string, merchant: MerchantFlag, checkedAt?: number): Promise<void>;

  /** Optional: persist a denormalized kind-0 profile snapshot for an entry (spec 044 #2). */
  setProfile?(pubkey: string, snapshot: FollowProfileSnapshot, updatedAt?: number): Promise<void>;
}

/** Options for FollowAdapter.add (spec 044). */
export interface AddFollowEntryOptions {
  source?: FollowEntry['source'];
  merchant?: MerchantFlag;
  merchantCheckedAt?: number | null;
  syncState?: FollowSyncState;
  order?: number;
  relayHint?: string | null;
  petname?: string | null;
  labels?: string[];
  displayName?: string | null;
  picture?: string | null;
  nip05?: string | null;
  profileUpdatedAt?: number | null;
}
