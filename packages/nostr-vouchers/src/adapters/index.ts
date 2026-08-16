/**
 * Adapter exports
 */

export type {
  StorageAdapterConfig,
  StorageAdapter,
  SyncMetadataStorage,
  FullStorageAdapter,
} from './StorageAdapter';

export {
  IndexedDBAdapter,
  createIndexedDBAdapter,
  STORES,
  VOUCHER_INDEXES,
  DEFAULT_DB_NAME,
  DEFAULT_DB_VERSION,
  type IndexedDBAdapterConfig,
} from './IndexedDBAdapter';

export {
  MemoryAdapter,
  createMemoryAdapter,
  type MemoryAdapterConfig,
} from './MemoryAdapter';
