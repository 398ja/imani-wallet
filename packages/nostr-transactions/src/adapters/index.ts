/**
 * Storage adapter exports
 */

// Base adapter interface
export type {
  StorageAdapterConfig,
  StorageAdapter,
  SyncMetadataStorage,
  FullStorageAdapter,
} from './StorageAdapter';

// IndexedDB adapter
export {
  IndexedDBAdapter,
  createIndexedDBAdapter,
  type IndexedDBAdapterConfig,
} from './IndexedDBAdapter';

// Memory adapter
export {
  MemoryAdapter,
  createMemoryAdapter,
  type MemoryAdapterConfig,
} from './MemoryAdapter';
