/**
 * Base storage adapter interface
 *
 * This interface defines the contract that all storage implementations must follow.
 */

import type {
  Transaction,
  TransactionInput,
  TransactionUpdate,
  TransactionFilter,
  TransactionQueryResult,
} from '../types';

/**
 * Storage adapter configuration
 */
export interface StorageAdapterConfig {
  /** Database or storage name */
  dbName?: string;
  /** Version for migrations */
  version?: number;
  /** Maximum number of transactions to store (0 = unlimited) */
  maxTransactions?: number;
}

/**
 * Base storage adapter interface
 *
 * Implementations:
 * - IndexedDBAdapter (browser, full features)
 * - MemoryAdapter (testing, Node.js)
 * - LocalStorageAdapter (browser, limited features)
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
   * Add a new transaction
   * @param input Transaction input data
   * @returns The created transaction
   */
  add(input: TransactionInput): Promise<Transaction>;

  /**
   * Add multiple transactions in a batch
   * @param inputs Array of transaction inputs
   * @returns Array of created transactions
   */
  addBatch(inputs: TransactionInput[]): Promise<Transaction[]>;

  /**
   * Get a transaction by ID
   * @param id Transaction ID
   * @returns Transaction or null if not found
   */
  get(id: string): Promise<Transaction | null>;

  /**
   * Get a transaction by event ID
   * @param eventId Nostr event ID
   * @returns Transaction or null if not found
   */
  getByEventId(eventId: string): Promise<Transaction | null>;

  /**
   * Update a transaction
   * @param id Transaction ID
   * @param update Update data
   * @returns Updated transaction
   */
  update(id: string, update: TransactionUpdate): Promise<Transaction>;

  /**
   * Delete a transaction by ID
   * @param id Transaction ID
   * @returns True if deleted, false if not found
   */
  delete(id: string): Promise<boolean>;

  /**
   * Delete multiple transactions
   * @param ids Transaction IDs
   * @returns Number of deleted transactions
   */
  deleteBatch(ids: string[]): Promise<number>;

  /**
   * Query transactions with filters
   * @param filter Query filter
   * @returns Query result with pagination
   */
  query(filter: TransactionFilter): Promise<TransactionQueryResult>;

  /**
   * Get all transactions (use with caution on large datasets)
   * @returns All transactions
   */
  getAll(): Promise<Transaction[]>;

  /**
   * Count transactions matching a filter
   * @param filter Optional filter
   * @returns Count of matching transactions
   */
  count(filter?: TransactionFilter): Promise<number>;

  /**
   * Check if a transaction exists by ID
   * @param id Transaction ID
   * @returns True if exists
   */
  exists(id: string): Promise<boolean>;

  /**
   * Clear all transactions
   */
  clear(): Promise<void>;

  /**
   * Get unsynced transactions
   * @returns Transactions that haven't been synced to relay
   */
  getUnsynced(): Promise<Transaction[]>;

  /**
   * Mark transactions as synced
   * @param ids Transaction IDs to mark as synced
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
