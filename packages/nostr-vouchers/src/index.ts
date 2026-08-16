/**
 * @imani/nostr-vouchers
 *
 * A package for managing vouchers in the Imani wallet ecosystem.
 * Provides storage, querying, grouping, and filtering capabilities.
 *
 * @example Basic usage
 * ```typescript
 * import { VoucherStore, VoucherQuery, VoucherGrouper } from '@imani/nostr-vouchers';
 *
 * // Create and initialize store
 * const store = new VoucherStore();
 * await store.init();
 *
 * // Add a voucher
 * const voucher = await store.add({
 *   faceValue: 100,
 *   faceUnit: 'USD',
 *   tokenAmount: 10000,
 *   backingStrategy: 'FULL',
 *   issuerId: 'merchant-pubkey',
 *   mintUrl: 'https://mint.example.com',
 * });
 *
 * // Query vouchers
 * const activeVouchers = await new VoucherQuery(store)
 *   .active()
 *   .currency('USD')
 *   .newest()
 *   .limit(10)
 *   .get();
 *
 * // Group by issuer
 * const byIssuer = await new VoucherGrouper(store)
 *   .byIssuer()
 *   .activeOnly()
 *   .sortByValue()
 *   .execute();
 * ```
 *
 * @example Shared database mode
 * ```typescript
 * import { createSharedDatabase, VoucherStore } from '@imani/nostr-vouchers';
 *
 * // Create shared database
 * const db = await createSharedDatabase({ dbName: 'imani-wallet' });
 *
 * // Pass to store
 * const store = new VoucherStore({ database: db });
 * await store.init();
 * ```
 */

// ==========================================
// Types
// ==========================================

export type {
  // Voucher types
  Voucher,
  VoucherInput,
  VoucherUpdate,
  MerchantMetadata,
  ReceptionMethod,
  // Filter types
  VoucherFilter,
  VoucherQueryResult,
  VoucherSortField,
  SortConfig,
  // Group types
  GroupByField,
  AggregationType,
  GroupSortField,
  GroupOptions,
  VoucherGroup,
  GroupResult,
  ConsolidationCriteria,
  // Event types
  VoucherEventType,
  VoucherEventPayloads,
  EventHandler,
  Unsubscribe,
  VoucherStats,
  SyncStatus,
  ExportFormat,
  ExportOptions,
  ExportResult,
} from './types';

export {
  // Enums
  VoucherStatus,
  BackingStrategy,
  // Helper functions
  createVoucher,
  isVoucherExpired,
  fromAutoRedemptionVoucher,
  // Filter helpers
  normalizeFilter,
  matchesFilter,
  sortVouchers,
  paginateVouchers,
  // Group helpers
  generateGroupKey,
  createEmptyGroup,
  addVoucherToGroup,
  finalizeGroup,
  sortGroups,
  canConsolidate,
  DEFAULT_GROUP_OPTIONS,
} from './types';

// ==========================================
// Errors
// ==========================================

export {
  VoucherError,
  StorageError,
  NotFoundError,
  ValidationError,
  SyncError,
  ErrorCodes,
} from './errors';

// ==========================================
// Utils
// ==========================================

export {
  TypedEventEmitter,
  createEventEmitter,
  formatCurrency,
  formatExpiry,
  formatAmount,
  formatTimestamp,
  formatRelativeTime,
  formatPubkey,
  getVoucherDisplayInfo,
  getStatusLabel,
  getBackingStrategyLabel,
  exportToCSV,
  exportToJSON,
  exportVouchers,
  type VoucherDisplayInfo,
} from './utils';

// ==========================================
// Adapters
// ==========================================

export type {
  StorageAdapterConfig,
  StorageAdapter,
  SyncMetadataStorage,
  FullStorageAdapter,
  IndexedDBAdapterConfig,
  MemoryAdapterConfig,
} from './adapters';

export {
  IndexedDBAdapter,
  createIndexedDBAdapter,
  MemoryAdapter,
  createMemoryAdapter,
  STORES,
  VOUCHER_INDEXES,
  DEFAULT_DB_NAME,
  DEFAULT_DB_VERSION,
} from './adapters';

// ==========================================
// Store
// ==========================================

export type { VoucherStoreConfig, StorageType } from './store';

export { VoucherStore, createVoucherStore } from './store';

// ==========================================
// Query
// ==========================================

export { VoucherQuery, createVoucherQuery } from './query';

// ==========================================
// Group
// ==========================================

export {
  VoucherGrouper,
  createVoucherGrouper,
  groupByIssuer,
  groupByCurrency,
  groupByBackingStrategy,
  getTopIssuers,
  getExpiringByIssuer,
} from './group';

// ==========================================
// Database
// ==========================================

export type { StoreDefinition, SharedDatabaseConfig } from './database';

export {
  createSharedDatabase,
  openSharedDatabase,
  sharedDatabaseExists,
  deleteSharedDatabase,
  getSharedDatabaseInfo,
  upgradeSharedDatabase,
  VOUCHER_STORES,
  VOUCHER_STORE_INDEXES,
  VOUCHER_STORE_DEFINITIONS,
  DEFAULT_SHARED_DB_NAME,
  DEFAULT_SHARED_DB_VERSION,
} from './database';

// ==========================================
// Integrations
// ==========================================

export {
  createPackageIntegration,
  TransactionTypes,
  TransactionDirections,
  type IntegrationConfig,
  type IntegrationResult,
  type IntegratedWalletConfig,
  type IntegratedWallet,
  type AutoRedemptionVoucher,
  type AutoRedemptionServiceInterface,
  type TransactionStoreInterface,
  type TransactionInput,
} from './integrations';
