/**
 * Base storage adapter interface
 *
 * This interface defines the contract that all storage implementations must follow.
 */

import type {
  Voucher,
  VoucherInput,
  VoucherUpdate,
  VoucherFilter,
  VoucherQueryResult,
} from '../types';

/**
 * Storage adapter configuration
 */
export interface StorageAdapterConfig {
  /** Database or storage name */
  dbName?: string;
  /** Version for migrations */
  version?: number;
  /** Maximum number of vouchers to store (0 = unlimited) */
  maxVouchers?: number;
  /** External database instance (for shared database) */
  database?: IDBDatabase;
}

/**
 * Base storage adapter interface
 *
 * Implementations:
 * - IndexedDBAdapter (browser, full features)
 * - MemoryAdapter (testing, Node.js)
 */
export interface StorageAdapter {
  /**
   * Initialize the storage
   */
  init(): Promise<void>;

  /**
   * Close the storage connection
   */
  close(): Promise<void>;

  /**
   * Check if storage is initialized
   */
  isInitialized(): boolean;

  /**
   * Add a new voucher
   * @param input Voucher input data
   * @returns The created voucher
   */
  add(input: VoucherInput): Promise<Voucher>;

  /**
   * Add multiple vouchers in a batch
   * @param inputs Array of voucher inputs
   * @returns Array of created vouchers
   */
  addBatch(inputs: VoucherInput[]): Promise<Voucher[]>;

  /**
   * Get a voucher by ID
   * @param id Voucher ID
   * @returns Voucher or null if not found
   */
  get(id: string): Promise<Voucher | null>;

  /**
   * Get a voucher by event ID
   * @param eventId Nostr event ID
   * @returns Voucher or null if not found
   */
  getByEventId(eventId: string): Promise<Voucher | null>;

  /**
   * Update a voucher
   * @param id Voucher ID
   * @param update Update data
   * @returns Updated voucher
   */
  update(id: string, update: VoucherUpdate): Promise<Voucher>;

  /**
   * Delete a voucher by ID
   * @param id Voucher ID
   * @returns True if deleted, false if not found
   */
  delete(id: string): Promise<boolean>;

  /**
   * Delete multiple vouchers
   * @param ids Voucher IDs
   * @returns Number of deleted vouchers
   */
  deleteBatch(ids: string[]): Promise<number>;

  /**
   * Query vouchers with filters
   * @param filter Query filter
   * @returns Query result with pagination
   */
  query(filter: VoucherFilter): Promise<VoucherQueryResult>;

  /**
   * Get all vouchers (use with caution on large datasets)
   * @returns All vouchers
   */
  getAll(): Promise<Voucher[]>;

  /**
   * Count vouchers matching a filter
   * @param filter Optional filter
   * @returns Count of matching vouchers
   */
  count(filter?: VoucherFilter): Promise<number>;

  /**
   * Check if a voucher exists by ID
   * @param id Voucher ID
   * @returns True if exists
   */
  exists(id: string): Promise<boolean>;

  /**
   * Clear all vouchers
   */
  clear(): Promise<void>;

  /**
   * Get unsynced vouchers
   * @returns Vouchers that haven't been synced to relay
   */
  getUnsynced(): Promise<Voucher[]>;

  /**
   * Mark vouchers as synced
   * @param ids Voucher IDs to mark as synced
   * @param eventIds Optional Nostr event IDs
   */
  markSynced(ids: string[], eventIds?: string[]): Promise<void>;
}

/**
 * Sync metadata storage interface
 */
export interface SyncMetadataStorage {
  /**
   * Get sync metadata value
   */
  getSyncMeta(key: string): Promise<unknown>;

  /**
   * Set sync metadata value
   */
  setSyncMeta(key: string, value: unknown): Promise<void>;

  /**
   * Get all sync metadata
   */
  getAllSyncMeta(): Promise<Record<string, unknown>>;

  /**
   * Clear sync metadata
   */
  clearSyncMeta(): Promise<void>;
}

/**
 * Combined storage adapter with sync metadata
 */
export interface FullStorageAdapter extends StorageAdapter, SyncMetadataStorage {}
