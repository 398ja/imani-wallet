/**
 * IndexedDB Adapter
 *
 * IndexedDB implementation of the StorageAdapter interface.
 * Supports both standalone mode (creates its own database) and
 * shared database mode (uses an external IDBDatabase instance).
 */

import type {
  Voucher,
  VoucherInput,
  VoucherUpdate,
  VoucherFilter,
  VoucherQueryResult,
} from '../types';
import {
  createVoucher,
  normalizeFilter,
  matchesFilter,
  sortVouchers,
  paginateVouchers,
} from '../types';
import type { FullStorageAdapter, StorageAdapterConfig } from './StorageAdapter';
import { StorageError, NotFoundError, ErrorCodes } from '../errors';

/**
 * IndexedDB configuration
 */
export interface IndexedDBAdapterConfig extends StorageAdapterConfig {
  /** Database name (ignored if external database provided) */
  dbName?: string;
  /** Database version (ignored if external database provided) */
  version?: number;
  /** External database instance for shared database mode */
  database?: IDBDatabase;
}

/**
 * Store names
 */
export const STORES = {
  VOUCHERS: 'vouchers',
  SYNC_METADATA: 'sync_metadata',
};

/**
 * Voucher index definitions
 */
export const VOUCHER_INDEXES = [
  { name: 'eventId', keyPath: 'eventId', unique: true },
  { name: 'status', keyPath: 'status', unique: false },
  { name: 'issuerId', keyPath: 'issuerId', unique: false },
  { name: 'faceUnit', keyPath: 'faceUnit', unique: false },
  { name: 'backingStrategy', keyPath: 'backingStrategy', unique: false },
  { name: 'createdAt', keyPath: 'createdAt', unique: false },
  { name: 'expiresAt', keyPath: 'expiresAt', unique: false },
  { name: 'synced', keyPath: 'synced', unique: false },
  { name: 'walletId', keyPath: 'walletId', unique: false },
  // Compound indexes
  { name: 'status_createdAt', keyPath: ['status', 'createdAt'], unique: false },
  { name: 'issuerId_faceUnit', keyPath: ['issuerId', 'faceUnit'], unique: false },
  { name: 'issuerId_faceUnit_ratio', keyPath: ['issuerId', 'faceUnit', 'issuanceRatio'], unique: false },
];

/**
 * Default database name
 */
export const DEFAULT_DB_NAME = 'imani-vouchers';
export const DEFAULT_DB_VERSION = 1;

/**
 * IndexedDB adapter
 */
export class IndexedDBAdapter implements FullStorageAdapter {
  private dbName: string;
  private version: number;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private isSharedDatabase: boolean = false;
  private _initialized: boolean = false;

  constructor(config: IndexedDBAdapterConfig = {}) {
    if (config.database) {
      // Shared database mode
      this.db = config.database;
      this.dbName = config.database.name;
      this.version = config.database.version;
      this.isSharedDatabase = true;
      this._initialized = true;
    } else {
      // Standalone mode
      this.dbName = config.dbName ?? DEFAULT_DB_NAME;
      this.version = config.version ?? DEFAULT_DB_VERSION;
      this.isSharedDatabase = false;
    }
  }

  /**
   * Initialize the database (standalone mode only)
   */
  async init(): Promise<void> {
    // If using shared database, already initialized
    if (this.isSharedDatabase) {
      this._initialized = true;
      return;
    }

    if (this._initialized && this.db) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(
          new StorageError(
            'IndexedDB is not available in this environment',
            ErrorCodes.DATABASE_NOT_AVAILABLE
          )
        );
        return;
      }

      const request = indexedDB.open(this.dbName, this.version);

      request.onerror = () => {
        reject(
          new StorageError(
            `Failed to open IndexedDB: ${request.error?.message}`,
            ErrorCodes.STORAGE_OPEN_FAILED,
            { cause: request.error ?? undefined }
          )
        );
      };

      request.onsuccess = () => {
        this.db = request.result;
        this._initialized = true;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        this.createStores(db);
      };
    });

    return this.initPromise;
  }

  /**
   * Create object stores and indexes
   */
  private createStores(db: IDBDatabase): void {
    // Vouchers store
    if (!db.objectStoreNames.contains(STORES.VOUCHERS)) {
      const voucherStore = db.createObjectStore(STORES.VOUCHERS, {
        keyPath: 'id',
      });

      for (const index of VOUCHER_INDEXES) {
        try {
          voucherStore.createIndex(index.name, index.keyPath, { unique: index.unique });
        } catch {
          // Index might already exist
        }
      }
    }

    // Sync metadata store
    if (!db.objectStoreNames.contains(STORES.SYNC_METADATA)) {
      db.createObjectStore(STORES.SYNC_METADATA, { keyPath: 'key' });
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    // Don't close shared databases
    if (this.isSharedDatabase) {
      this._initialized = false;
      this.db = null;
      return;
    }

    if (this.db) {
      this.db.close();
      this.db = null;
      this._initialized = false;
      this.initPromise = null;
    }
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this._initialized && this.db !== null;
  }

  /**
   * Ensure database is ready
   */
  private ensureDb(): IDBDatabase {
    if (!this.db) {
      throw new StorageError(
        'Database not initialized. Call init() first.',
        ErrorCodes.STORAGE_NOT_INITIALIZED
      );
    }
    return this.db;
  }

  /**
   * Execute a transaction
   */
  private async transaction<T>(
    storeNames: string | string[],
    mode: IDBTransactionMode,
    callback: (stores: Record<string, IDBObjectStore>) => IDBRequest | IDBRequest[]
  ): Promise<T> {
    const db = this.ensureDb();

    return new Promise((resolve, reject) => {
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      const tx = db.transaction(names, mode);

      const stores: Record<string, IDBObjectStore> = {};
      for (const name of names) {
        stores[name] = tx.objectStore(name);
      }

      const requests = callback(stores);
      const requestArray = Array.isArray(requests) ? requests : [requests];
      const lastRequest = requestArray[requestArray.length - 1];

      tx.oncomplete = () => {
        resolve(lastRequest?.result as T);
      };

      tx.onerror = () => {
        reject(
          new StorageError(`Transaction failed: ${tx.error?.message}`, ErrorCodes.STORAGE_WRITE_FAILED, {
            cause: tx.error ?? undefined,
          })
        );
      };
    });
  }

  // ==========================================
  // Voucher CRUD Operations
  // ==========================================

  async add(input: VoucherInput): Promise<Voucher> {
    const voucher = createVoucher(input);
    await this.transaction(STORES.VOUCHERS, 'readwrite', (stores) => {
      return stores[STORES.VOUCHERS]!.add(voucher);
    });
    return voucher;
  }

  async addBatch(inputs: VoucherInput[]): Promise<Voucher[]> {
    const vouchers = inputs.map((input) => createVoucher(input));
    const db = this.ensureDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readwrite');
      const store = tx.objectStore(STORES.VOUCHERS);

      for (const voucher of vouchers) {
        store.add(voucher);
      }

      tx.oncomplete = () => resolve(vouchers);
      tx.onerror = () =>
        reject(
          new StorageError(`Batch add failed: ${tx.error?.message}`, ErrorCodes.STORAGE_WRITE_FAILED)
        );
    });
  }

  async get(id: string): Promise<Voucher | null> {
    const result = await this.transaction<Voucher | undefined>(
      STORES.VOUCHERS,
      'readonly',
      (stores) => stores[STORES.VOUCHERS]!.get(id)
    );
    return result ?? null;
  }

  async getByEventId(eventId: string): Promise<Voucher | null> {
    const db = this.ensureDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readonly');
      const store = tx.objectStore(STORES.VOUCHERS);
      const index = store.index('eventId');
      const request = index.get(eventId);

      request.onsuccess = () => resolve((request.result as Voucher) ?? null);
      request.onerror = () =>
        reject(new StorageError(`Query failed: ${request.error?.message}`, ErrorCodes.STORAGE_READ_FAILED));
    });
  }

  async update(id: string, update: VoucherUpdate): Promise<Voucher> {
    const db = this.ensureDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readwrite');
      const store = tx.objectStore(STORES.VOUCHERS);
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const existing = getRequest.result as Voucher | undefined;
        if (!existing) {
          reject(new NotFoundError(id));
          return;
        }

        const updated: Voucher = {
          ...existing,
          ...update,
          updatedAt: new Date().toISOString(),
        };

        store.put(updated);

        tx.oncomplete = () => resolve(updated);
      };

      tx.onerror = () =>
        reject(new StorageError(`Update failed: ${tx.error?.message}`, ErrorCodes.STORAGE_WRITE_FAILED));
    });
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    await this.transaction(STORES.VOUCHERS, 'readwrite', (stores) => stores[STORES.VOUCHERS]!.delete(id));
    return true;
  }

  async deleteBatch(ids: string[]): Promise<number> {
    const db = this.ensureDb();
    let deleted = 0;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readwrite');
      const store = tx.objectStore(STORES.VOUCHERS);

      for (const id of ids) {
        const request = store.delete(id);
        request.onsuccess = () => deleted++;
      }

      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () =>
        reject(new StorageError(`Batch delete failed: ${tx.error?.message}`, ErrorCodes.STORAGE_DELETE_FAILED));
    });
  }

  async query(filter: VoucherFilter): Promise<VoucherQueryResult> {
    const normalized = normalizeFilter(filter);
    const allVouchers = await this.getAll();

    // Apply filters
    const filtered = allVouchers.filter((v) => matchesFilter(v, normalized));

    // Sort
    const sorted = sortVouchers(filtered, {
      field: normalized.sortBy,
      order: normalized.sortOrder,
    });

    // Paginate
    const { vouchers, hasMore } = paginateVouchers(sorted, normalized.offset, normalized.limit);

    return {
      vouchers,
      total: filtered.length,
      hasMore,
      offset: normalized.offset,
      limit: normalized.limit,
    };
  }

  async getAll(): Promise<Voucher[]> {
    return this.transaction<Voucher[]>(STORES.VOUCHERS, 'readonly', (stores) =>
      stores[STORES.VOUCHERS]!.getAll()
    );
  }

  async count(filter?: VoucherFilter): Promise<number> {
    if (!filter) {
      const db = this.ensureDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.VOUCHERS, 'readonly');
        const store = tx.objectStore(STORES.VOUCHERS);
        const request = store.count();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(new StorageError(`Count failed: ${request.error?.message}`, ErrorCodes.STORAGE_READ_FAILED));
      });
    }

    // With filter, we need to count matching
    const allVouchers = await this.getAll();
    const normalized = normalizeFilter(filter);
    return allVouchers.filter((v) => matchesFilter(v, normalized)).length;
  }

  async exists(id: string): Promise<boolean> {
    const voucher = await this.get(id);
    return voucher !== null;
  }

  async clear(): Promise<void> {
    await this.transaction(STORES.VOUCHERS, 'readwrite', (stores) => stores[STORES.VOUCHERS]!.clear());
  }

  async getUnsynced(): Promise<Voucher[]> {
    const db = this.ensureDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readonly');
      const store = tx.objectStore(STORES.VOUCHERS);
      const index = store.index('synced');
      const request = index.getAll(IDBKeyRange.only(false));

      request.onsuccess = () => resolve(request.result as Voucher[]);
      request.onerror = () =>
        reject(new StorageError(`Query failed: ${request.error?.message}`, ErrorCodes.STORAGE_READ_FAILED));
    });
  }

  async markSynced(ids: string[], eventIds?: string[]): Promise<void> {
    const db = this.ensureDb();
    const now = Math.floor(Date.now() / 1000);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readwrite');
      const store = tx.objectStore(STORES.VOUCHERS);

      ids.forEach((id, index) => {
        const getRequest = store.get(id);
        getRequest.onsuccess = () => {
          const voucher = getRequest.result as Voucher | undefined;
          if (voucher) {
            voucher.synced = true;
            voucher.syncedAt = now;
            if (eventIds && eventIds[index]) {
              voucher.eventId = eventIds[index];
            }
            store.put(voucher);
          }
        };
      });

      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(new StorageError(`Mark synced failed: ${tx.error?.message}`, ErrorCodes.STORAGE_WRITE_FAILED));
    });
  }

  // ==========================================
  // Sync Metadata Operations
  // ==========================================

  async getSyncMeta(key: string): Promise<unknown> {
    const result = await this.transaction<{ key: string; value: unknown } | undefined>(
      STORES.SYNC_METADATA,
      'readonly',
      (stores) => stores[STORES.SYNC_METADATA]!.get(key)
    );
    return result?.value;
  }

  async setSyncMeta(key: string, value: unknown): Promise<void> {
    await this.transaction(STORES.SYNC_METADATA, 'readwrite', (stores) =>
      stores[STORES.SYNC_METADATA]!.put({ key, value })
    );
  }

  async getAllSyncMeta(): Promise<Record<string, unknown>> {
    const items = await this.transaction<Array<{ key: string; value: unknown }>>(
      STORES.SYNC_METADATA,
      'readonly',
      (stores) => stores[STORES.SYNC_METADATA]!.getAll()
    );

    const result: Record<string, unknown> = {};
    for (const item of items) {
      result[item.key] = item.value;
    }
    return result;
  }

  async clearSyncMeta(): Promise<void> {
    await this.transaction(STORES.SYNC_METADATA, 'readwrite', (stores) =>
      stores[STORES.SYNC_METADATA]!.clear()
    );
  }

  // ==========================================
  // Additional Utility Methods
  // ==========================================

  /**
   * Get vouchers by status
   */
  async getByStatus(status: string): Promise<Voucher[]> {
    const db = this.ensureDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readonly');
      const store = tx.objectStore(STORES.VOUCHERS);
      const index = store.index('status');
      const request = index.getAll(status);

      request.onsuccess = () => resolve(request.result as Voucher[]);
      request.onerror = () =>
        reject(new StorageError(`Query failed: ${request.error?.message}`, ErrorCodes.STORAGE_READ_FAILED));
    });
  }

  /**
   * Get vouchers by issuer
   */
  async getByIssuer(issuerId: string): Promise<Voucher[]> {
    const db = this.ensureDb();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readonly');
      const store = tx.objectStore(STORES.VOUCHERS);
      const index = store.index('issuerId');
      const request = index.getAll(issuerId);

      request.onsuccess = () => resolve(request.result as Voucher[]);
      request.onerror = () =>
        reject(new StorageError(`Query failed: ${request.error?.message}`, ErrorCodes.STORAGE_READ_FAILED));
    });
  }

  /**
   * Delete the entire database (standalone mode only)
   */
  async deleteDatabase(): Promise<void> {
    if (this.isSharedDatabase) {
      throw new StorageError(
        'Cannot delete shared database',
        ErrorCodes.STORAGE_DELETE_FAILED
      );
    }

    await this.close();

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new StorageError(`Failed to delete database: ${request.error?.message}`, ErrorCodes.STORAGE_DELETE_FAILED));
    });
  }
}

/**
 * Create an IndexedDB adapter instance
 */
export function createIndexedDBAdapter(config: IndexedDBAdapterConfig = {}): IndexedDBAdapter {
  return new IndexedDBAdapter(config);
}
