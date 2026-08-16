/**
 * @imani/nostr-transactions
 *
 * Transaction management library for Nostr with local storage and relay sync
 *
 * @example
 * ```typescript
 * import {
 *   TransactionStore,
 *   TransactionType,
 *   TransactionDirection
 * } from '@imani/nostr-transactions';
 *
 * // Create the store
 * const store = new TransactionStore({
 *   storage: 'indexeddb',
 *   dbName: 'my-transactions'
 * });
 *
 * await store.init();
 *
 * // Record a transaction
 * await store.record({
 *   type: TransactionType.RECEIVED,
 *   direction: TransactionDirection.IN,
 *   tokenAmount: 1000,
 *   faceValue: 5000,
 *   faceUnit: 'USD',
 *   faceDecimals: 2,
 *   counterparty: 'sender-pubkey',
 *   counterpartyName: 'Alice',
 *   memo: 'Thanks!'
 * });
 *
 * // Query transactions
 * const recent = await store.query({ limit: 10 });
 * const received = await store.query({
 *   type: TransactionType.RECEIVED,
 *   sortBy: 'timestamp',
 *   sortOrder: 'desc'
 * });
 * ```
 */

// ============================================
// Types
// ============================================

export type {
  // Transaction types
  Transaction,
  TransactionInput,
  TransactionUpdate,
  // Filter types
  TransactionFilter,
  TransactionQueryResult,
  SortConfig,
  // Event types
  TransactionEventType,
  TransactionEventPayloads,
  TransactionAddedEvent,
  TransactionUpdatedEvent,
  TransactionDeletedEvent,
  TransactionBatchAddedEvent,
  SyncStartedEvent,
  SyncProgressEvent,
  SyncCompletedEvent,
  SyncErrorEvent,
  StoreOpenedEvent,
  StoreClosedEvent,
  StoreErrorEvent,
  EventHandler,
  Unsubscribe,
  TransactionStats,
  ExportOptions,
  ExportResult,
  SyncStatus,
} from './types';

export {
  TransactionType,
  TransactionDirection,
  getDirectionFromType,
  generateTransactionId,
  createTransaction,
  DEFAULT_FILTER,
  normalizeFilter,
  matchesFilter,
  sortTransactions,
  paginateTransactions,
} from './types';

// ============================================
// Store
// ============================================

export {
  // Schema
  DB_NAME,
  DB_VERSION,
  STORES,
  TRANSACTION_INDEXES,
  SYNC_METADATA_KEYS,
  type IndexDefinition,
  createSchema,
  upgradeSchema,
  // Transaction Store
  TransactionStore,
  createTransactionStore,
  type TransactionStoreConfig,
  type StorageType,
  // Bundle Receipt Store (spec 012-multi-voucher-send)
  BundleReceiptStore,
  createBundleReceiptStore,
  type BundleReceiptStoreConfig,
  type BundleReceiptStorageAdapter,
  type BundleReceiptClock,
  type BundleReceiptIngestInput,
  type BundleReceiptDirective,
  type BundleReceiptRecord,
  type BundleReceiptState,
  type RedemptionStatus,
  type ReceivedPartRecord,
  type MetadataDisagreement,
  type ReconciliationResult,
} from './store';

// ============================================
// Adapters
// ============================================

export type {
  StorageAdapterConfig,
  StorageAdapter,
  SyncMetadataStorage,
  FullStorageAdapter,
} from './adapters';

export {
  // IndexedDB adapter
  IndexedDBAdapter,
  createIndexedDBAdapter,
  type IndexedDBAdapterConfig,
  // Memory adapter
  MemoryAdapter,
  createMemoryAdapter,
  type MemoryAdapterConfig,
} from './adapters';

// ============================================
// Query
// ============================================

export {
  TransactionQuery,
  createQuery,
} from './query';

// ============================================
// Sync
// ============================================

export {
  // Types
  NIP60_HISTORY_KIND,
  type NostrEvent,
  type UnsignedEvent,
  type NostrSigner,
  type CryptoProvider,
  type RelaySyncConfig,
  type SyncDirection,
  type SyncResult,
  type SyncError as RelaySyncError,
  type SyncStatus as RelaySyncStatus,
  type Nip60HistoryContent,
  transactionToHistoryContent,
  historyContentToTransaction,
  // Event Builder
  EventBuilder,
  createEventBuilder,
  type EventBuilderConfig,
  // Relay Sync
  RelaySync,
  createRelaySync,
  SimpleRelayPool,
  type RelayConnection,
  type RelayPool,
} from './sync';

// ============================================
// Errors
// ============================================

export {
  TransactionError,
  StorageError,
  NotFoundError,
  ValidationError,
  QueryError,
  SyncError,
  SyncConflictError,
  ErrorCodes,
  type ErrorCode,
  isTransactionError,
  isErrorCode,
  isRetryableError,
} from './errors';

// ============================================
// Utilities
// ============================================

export {
  // Event emitter
  TypedEventEmitter,
  createEventEmitter,
  // Formatting
  formatAmount,
  formatCurrency,
  formatTimestamp,
  formatRelativeTime,
  formatPubkey,
  getTransactionDisplayName,
  getTransactionTypeLabel,
  getDirectionIndicator,
  formatTransactionLine,
  exportToCSV,
  exportToJSON,
} from './utils';

// ============================================
// Version
// ============================================

export const VERSION = '0.1.0';
