// Types
export type {
  // Profile types
  Profile,
  MerchantProfile,
  ProfileLocation,
  FullProfile,
  // NIP-05 types
  Nip05Result,
  // Filter types
  ProfileFilter,
  ProfileSearchResult,
  LocationFilter,
  ScoringWeights,
  // Follow types
  FollowEntry,
  AddFollowOptions,
  FollowList,
  FollowSyncStatus,
  // Event types
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
  // Cache types
  CacheEntry,
  CacheConfig,
  CacheStore,
  CacheStats,
  // Adapter types
  DirectoryAdapter,
  LookupAdapter,
  FollowAdapter,
  // Config types
  ProfileServiceOptions,
} from './types/index.js';

// Error classes and factory functions
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
} from './types/index.js';

// Cache implementations
export { MemoryCacheStore, createMemoryCache } from './cache/MemoryCacheStore.js';
export { IndexedDBCacheStore, createIndexedDBCache } from './cache/IndexedDBCacheStore.js';

// Core services
export {
  Nip05Resolver,
  createNip05Resolver,
  type Nip05ResolverConfig,
} from './core/Nip05Resolver.js';

export {
  ProfileLookup,
  createProfileLookup,
  type ProfileLookupConfig,
} from './core/ProfileLookup.js';

export {
  ProfileDirectory,
  createProfileDirectory,
  type ProfileDirectoryConfig,
} from './core/ProfileDirectory.js';

export {
  FollowManager,
  createFollowManager,
  type FollowManagerConfig,
} from './core/FollowManager.js';

export {
  KIND_CONTACTS,
  parseContactListEvent,
  pickLatestValid,
  buildContactListTags,
  reconcile,
  type RemoteFollowEntry,
  type RemoteFollowList,
  type ReconcileResult,
  type VerifyEventFn,
} from './core/followSync.js';

export {
  FollowSyncCoordinator,
  createFollowSyncCoordinator,
  type FollowSyncCoordinatorConfig,
  type FollowLocalStore,
  type RemoteFollowSource,
} from './core/FollowSyncCoordinator.js';

export {
  ProfileService,
  createProfileService,
  type ProfileServiceConfig,
} from './core/ProfileService.js';

export {
  ProfileDisplayResolver,
  createProfileDisplayResolver,
  getProfileDisplay,
  resolveProfileDisplay,
  formatProfileDisplay,
  detectIdentifierType,
  getBestDisplayName,
  isValidNpub,
  npubToHex,
  hexToNpub,
  type ProfileDisplayResolverConfig,
  type ProfileDisplayInfo,
  type IdentifierType,
} from './core/ProfileDisplay.js';

// Adapters - Local
export {
  LocalFollowAdapter,
  MemoryFollowAdapter,
  createLocalFollowAdapter,
  type LocalFollowAdapterConfig,
} from './adapters/LocalFollowAdapter.js';

// Adapters - Nostr
export {
  NostrLookupAdapter,
  createNostrLookupAdapter,
  type NostrLookupAdapterConfig,
  type NostrPool,
  type NostrFilter,
  type NostrEvent,
} from './adapters/NostrLookupAdapter.js';

export {
  NostrDirectoryAdapter,
  createNostrDirectoryAdapter,
  type NostrDirectoryAdapterConfig,
} from './adapters/NostrDirectoryAdapter.js';

export {
  NostrFollowAdapter,
  createNostrFollowAdapter,
  type NostrFollowAdapterConfig,
  type NostrSigner,
  type NostrPublisher,
  type UnsignedNostrEvent,
} from './adapters/NostrFollowAdapter.js';

export {
  NostrFollowSource,
  createNostrFollowSource,
  type NostrFollowSourceConfig,
} from './adapters/NostrFollowSource.js';

// Adapters - API
export {
  ImaniApiAdapter,
  createImaniApiAdapter,
  FetchHttpClient,
  type ImaniApiAdapterConfig,
  type HttpClient,
  type RequestOptions,
} from './adapters/ImaniApiAdapter.js';

// Filters
export {
  filterProfiles,
  filterMerchantOnly,
  filterByCurrencies,
  filterByQuery,
  filterByLocation,
  paginateResults,
  parseCursor,
  createCursor,
  splitFilter,
  type FilterCapabilities,
} from './filters/FilterEngine.js';

export {
  scoreProfile,
  sortByScore,
  scoreAndSort,
  DEFAULT_WEIGHTS,
} from './filters/Scoring.js';

// Utilities
export { SimpleEventEmitter, createEventHelpers } from './utils/eventEmitter.js';
export {
  validatePubkey,
  isValidPubkey,
  validateNip05,
  isValidNip05,
  normalizePubkey,
  validateLocation,
} from './utils/validate.js';
export {
  haversineDistance,
  isWithinRadius,
  boundingBox,
  isInBoundingBox,
} from './utils/geo.js';
export { isConfiguredMerchant, KNOWN_PRICED_CURRENCIES } from './utils/merchant.js';
export type { MerchantProfileLike } from './utils/merchant.js';

// Factory functions
export {
  createBrowserService,
  createNodeService,
  createMinimalService,
  type BaseFactoryConfig,
  type BrowserFactoryConfig,
  type NodeFactoryConfig,
} from './factories.js';
