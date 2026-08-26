// Profile types
export type {
  Profile,
  MerchantProfile,
  ProfileLocation,
  FullProfile,
} from './profile.js';

// NIP-05 types
export type { Nip05Result, Nip05Resolver } from './nip05.js';

// Filter types
export type {
  ProfileFilter,
  ProfileSearchResult,
  LocationFilter,
  ScoringWeights,
} from './filters.js';

// Follow types
export type {
  FollowEntry,
  FollowProfileSnapshot,
  MerchantFlag,
  FollowSyncState,
  AddFollowOptions,
  FollowList,
  FollowSyncStatus,
} from './follow.js';

// Event types
export type {
  ProfileEventType,
  ProfileEventBase,
  ProfileEvent,
  ProfileEventListener,
  ProfileEventEmitter,
  FollowAddedEvent,
  FollowRemovedEvent,
  FollowSyncErrorEvent,
  SearchExecutedEvent,
  ProfileViewedEvent,
  CacheHitEvent,
  CacheMissEvent,
} from './events.js';

// Cache types
export type {
  CacheEntry,
  CacheConfig,
  CacheStore,
  CacheStats,
} from './cache.js';

// Adapter types
export type {
  DirectoryAdapter,
  LookupAdapter,
  FollowAdapter,
} from './adapters.js';

// Config types
export type { ProfileServiceConfig, ProfileServiceOptions } from './config.js';

// Error types
export {
  ProfileErrorCode,
  ProfileError,
  networkError,
  relayTimeoutError,
  invalidPubkeyError,
  nip05ResolutionError,
  profileNotFoundError,
  cacheError,
  followSyncError,
  rateLimitError,
  validationError,
  storageError,
} from './errors.js';
