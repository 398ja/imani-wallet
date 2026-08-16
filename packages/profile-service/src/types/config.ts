import type { DirectoryAdapter, LookupAdapter, FollowAdapter } from './adapters.js';
import type { CacheStore } from './cache.js';
import type { ProfileEventListener } from './events.js';

/**
 * ProfileService configuration
 */
export interface ProfileServiceConfig {
  /** Directory adapter for searching profiles */
  directoryAdapter: DirectoryAdapter;
  /** Lookup adapter for fetching individual profiles */
  lookupAdapter: LookupAdapter;
  /** Follow adapter for managing follow list */
  followAdapter: FollowAdapter;
  /** Optional cache store */
  cache?: CacheStore;
  /** Event listener for profile events */
  onEvent?: ProfileEventListener;
}

/**
 * ProfileService options (partial config)
 */
export interface ProfileServiceOptions {
  /** Directory adapter for searching profiles */
  directoryAdapter?: DirectoryAdapter;
  /** Lookup adapter for fetching individual profiles */
  lookupAdapter?: LookupAdapter;
  /** Follow adapter for managing follow list */
  followAdapter?: FollowAdapter;
  /** Optional cache store */
  cache?: CacheStore;
  /** Event listener for profile events */
  onEvent?: ProfileEventListener;
}
