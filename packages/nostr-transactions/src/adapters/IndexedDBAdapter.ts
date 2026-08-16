/**
 * IndexedDB storage adapter implementation
 *
 * Provides full-featured transaction storage using IndexedDB for browser environments.
 */

import type {
  Transaction,
  TransactionInput,
  TransactionUpdate,
  TransactionFilter,
  TransactionQueryResult,
} from '../types';
import {
  createTransaction,
  normalizeFilter,
  matchesFilter,
  sortTransactions,
} from '../types';
import type { FullStorageAdapter, StorageAdapterConfig } from './StorageAdapter';
import {
  DB_NAME,
  DB_VERSION,
  STORES,
  upgradeSchema,
} from '../store/schema';

/**
 * IndexedDB adapter configuration
 */
export interface IndexedDBAdapterConfig extends StorageAdapterConfig {
  /** IndexedDB factory (for testing with fake-indexeddb) */
  indexedDB?: IDBFactory;
}

/**
 * IndexedDB storage adapter
 */
export class IndexedDBAdapter implements FullStorageAdapter {
  private db: IDBDatabase | null = null;
  private readonly config: Required<IndexedDBAdapterConfig>;
  private readonly indexedDBFactory: IDBFactory;

  constructor(config: IndexedDBAdapterConfig = {}) {
    this.config = {
      dbName: config.dbName ?? DB_NAME,
      version: config.version ?? DB_VERSION,
      maxTransactions: config.maxTransactions ?? 0,
      indexedDB: config.indexedDB ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined!),
    };
    this.indexedDBFactory = this.config.indexedDB;
  }

  /**
   * Initialize the database connection
   */
  async init(): Promise<void> {
    if (this.db) {
      return;
    }

    if (!this.indexedDBFactory) {
      throw new Error('IndexedDB is not available in this environment');
    }

    return new Promise((resolve, reject) => {
      const request = this.indexedDBFactory.open(this.config.dbName, this.config.version);

      request.onerror = () => {
        reject(new Error(`Failed to open database: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const transaction = request.transaction!;
        upgradeSchema(db, event.oldVersion, event.newVersion, transaction);
      };
    });
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.db !== null;
  }

  /**
   * Get the database instance
   */
  private getDb(): IDBDatabase {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.');
    }
    return this.db;
  }

  /**
   * Create a transaction store accessor
   */
  private getStore(mode: IDBTransactionMode): IDBObjectStore {
    const db = this.getDb();
    const tx = db.transaction(STORES.TRANSACTIONS, mode);
    return tx.objectStore(STORES.TRANSACTIONS);
  }

  /**
   * Create a sync metadata store accessor
   */
  private getSyncStore(mode: IDBTransactionMode): IDBObjectStore {
    const db = this.getDb();
    const tx = db.transaction(STORES.SYNC_METADATA, mode);
    return tx.objectStore(STORES.SYNC_METADATA);
  }

  /**
   * Helper to wrap IDB request in a Promise
   */
  private promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Add a transaction
   */
  async add(input: TransactionInput): Promise<Transaction> {
    const tx = createTransaction(input);
    const store = this.getStore('readwrite');
    await this.promisify(store.add(tx));
    return tx;
  }

  /**
   * Add multiple transactions in a batch
   */
  async addBatch(inputs: TransactionInput[]): Promise<Transaction[]> {
    const transactions = inputs.map(createTransaction);
    const db = this.getDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.TRANSACTIONS, 'readwrite');
      const store = tx.objectStore(STORES.TRANSACTIONS);

      tx.oncomplete = () => resolve(transactions);
      tx.onerror = () => reject(tx.error);

      for (const transaction of transactions) {
        store.add(transaction);
      }
    });
  }

  /**
   * Get a transaction by ID
   */
  async get(id: string): Promise<Transaction | null> {
    const store = this.getStore('readonly');
    const result = await this.promisify(store.get(id));
    return result ?? null;
  }

  /**
   * Get a transaction by event ID
   */
  async getByEventId(eventId: string): Promise<Transaction | null> {
    const store = this.getStore('readonly');
    const index = store.index('eventId');
    const result = await this.promisify(index.get(eventId));
    return result ?? null;
  }

  /**
   * Update a transaction
   */
  async update(id: string, update: TransactionUpdate): Promise<Transaction> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Transaction not found: ${id}`);
    }

    const updated: Transaction = {
      ...existing,
      ...update,
    };

    const store = this.getStore('readwrite');
    await this.promisify(store.put(updated));
    return updated;
  }

  /**
   * Delete a transaction by ID
   */
  async delete(id: string): Promise<boolean> {
    const exists = await this.exists(id);
    if (!exists) {
      return false;
    }

    const store = this.getStore('readwrite');
    await this.promisify(store.delete(id));
    return true;
  }

  /**
   * Delete multiple transactions
   */
  async deleteBatch(ids: string[]): Promise<number> {
    const db = this.getDb();
    let deleted = 0;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.TRANSACTIONS, 'readwrite');
      const store = tx.objectStore(STORES.TRANSACTIONS);

      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => reject(tx.error);

      for (const id of ids) {
        const request = store.delete(id);
        request.onsuccess = () => deleted++;
      }
    });
  }

  /**
   * Query transactions with filters
   */
  async query(filter: TransactionFilter): Promise<TransactionQueryResult> {
    const normalizedFilter = normalizeFilter(filter);
    const { limit, offset, sortBy, sortOrder } = normalizedFilter;

    // Get all transactions and filter in memory
    // For large datasets, we could use index-based queries for specific filters
    let transactions = await this.getAll();

    // Apply filters
    transactions = transactions.filter((tx) => matchesFilter(tx, normalizedFilter));

    // Count total before pagination
    const total = transactions.length;

    // Sort
    transactions = sortTransactions(transactions, sortBy, sortOrder);

    // Paginate
    const paginated = transactions.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return {
      transactions: paginated,
      total,
      hasMore,
      offset,
      limit,
    };
  }

  /**
   * Get all transactions
   */
  async getAll(): Promise<Transaction[]> {
    const store = this.getStore('readonly');
    return this.promisify(store.getAll());
  }

  /**
   * Count transactions
   */
  async count(filter?: TransactionFilter): Promise<number> {
    if (!filter) {
      const store = this.getStore('readonly');
      return this.promisify(store.count());
    }

    // Count with filter requires fetching all (could be optimized with index queries)
    const transactions = await this.getAll();
    const normalizedFilter = normalizeFilter(filter);
    return transactions.filter((tx) => matchesFilter(tx, normalizedFilter)).length;
  }

  /**
   * Check if a transaction exists
   */
  async exists(id: string): Promise<boolean> {
    const store = this.getStore('readonly');
    const result = await this.promisify(store.getKey(id));
    return result !== undefined;
  }

  /**
   * Clear all transactions
   */
  async clear(): Promise<void> {
    const store = this.getStore('readwrite');
    await this.promisify(store.clear());
  }

  /**
   * Get unsynced transactions
   */
  async getUnsynced(): Promise<Transaction[]> {
    // IndexedDB doesn't support boolean key ranges well, so filter in memory
    const all = await this.getAll();
    return all.filter((tx) => !tx.synced);
  }

  /**
   * Mark transactions as synced
   */
  async markSynced(ids: string[], eventIds?: string[]): Promise<void> {
    const db = this.getDb();
    const now = Math.floor(Date.now() / 1000);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.TRANSACTIONS, 'readwrite');
      const store = tx.objectStore(STORES.TRANSACTIONS);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      ids.forEach((id, index) => {
        const request = store.get(id);
        request.onsuccess = () => {
          const transaction = request.result;
          if (transaction) {
            transaction.synced = true;
            transaction.syncedAt = now;
            if (eventIds && eventIds[index]) {
              transaction.eventId = eventIds[index];
            }
            store.put(transaction);
          }
        };
      });
    });
  }

  // ==================== Sync Metadata ====================

  /**
   * Get sync metadata value
   */
  async getSyncMeta(key: string): Promise<unknown> {
    const store = this.getSyncStore('readonly');
    const result = await this.promisify(store.get(key));
    return result?.value;
  }

  /**
   * Set sync metadata value
   */
  async setSyncMeta(key: string, value: unknown): Promise<void> {
    const store = this.getSyncStore('readwrite');
    await this.promisify(store.put({ key, value }));
  }

  /**
   * Get all sync metadata
   */
  async getAllSyncMeta(): Promise<Record<string, unknown>> {
    const store = this.getSyncStore('readonly');
    const all = await this.promisify(store.getAll());
    const result: Record<string, unknown> = {};
    for (const item of all) {
      result[item.key] = item.value;
    }
    return result;
  }

  /**
   * Clear sync metadata
   */
  async clearSyncMeta(): Promise<void> {
    const store = this.getSyncStore('readwrite');
    await this.promisify(store.clear());
  }
}

/**
 * Create an IndexedDB adapter
 */
export function createIndexedDBAdapter(config?: IndexedDBAdapterConfig): IndexedDBAdapter {
  return new IndexedDBAdapter(config);
}
