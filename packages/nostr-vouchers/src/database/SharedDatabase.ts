/**
 * SharedDatabase - Factory for creating shared IndexedDB databases
 *
 * This module provides utilities for creating a shared database that can be
 * used by multiple packages (vouchers, auto-redemption, transactions).
 *
 * Usage:
 * 1. Create a shared database using createSharedDatabase()
 * 2. Pass the database to VoucherStore via the `database` config option
 * 3. Other packages can use the same database instance
 */

import { STORES, VOUCHER_INDEXES } from '../adapters/IndexedDBAdapter';
import { StorageError, ErrorCodes } from '../errors';

/**
 * Store definitions from this package
 */
export const VOUCHER_STORES = STORES;
export const VOUCHER_STORE_INDEXES = {
  [STORES.VOUCHERS]: VOUCHER_INDEXES,
};

/**
 * Configuration for creating object stores
 */
export interface StoreDefinition {
  /** Store name */
  name: string;
  /** Key path for the store */
  keyPath: string;
  /** Auto-increment the key */
  autoIncrement?: boolean;
  /** Index definitions */
  indexes?: Array<{
    name: string;
    keyPath: string | string[];
    unique?: boolean;
  }>;
}

/**
 * Configuration for shared database
 */
export interface SharedDatabaseConfig {
  /** Database name */
  dbName?: string;
  /** Database version */
  version?: number;
  /** Additional store definitions from other packages */
  additionalStores?: StoreDefinition[];
}

/**
 * Default shared database name
 */
export const DEFAULT_SHARED_DB_NAME = 'imani-wallet';
/**
 * v1 → v2 (spec 024, 2026-05-17): bumped to accommodate the two new
 * `wallet_vouchers` + `wallet_transactions` object stores contributed
 * by `@imani/wallet-storage` via `additionalStores`. The upgrade is
 * purely additive — the existing `vouchers` + `sync_metadata` stores
 * and their data are untouched. See
 * `specs/024-vouchers-tx-idb-migration/research.md` §R2 for the
 * single-owner version-bump rationale.
 */
export const DEFAULT_SHARED_DB_VERSION = 2;

/**
 * Voucher store definitions
 */
export const VOUCHER_STORE_DEFINITIONS: StoreDefinition[] = [
  {
    name: STORES.VOUCHERS,
    keyPath: 'id',
    indexes: VOUCHER_INDEXES,
  },
  {
    name: STORES.SYNC_METADATA,
    keyPath: 'key',
  },
];

/**
 * Create object stores from definitions
 */
function createStoresFromDefinitions(db: IDBDatabase, definitions: StoreDefinition[]): void {
  for (const storeDef of definitions) {
    // Create store if it doesn't exist
    if (!db.objectStoreNames.contains(storeDef.name)) {
      const store = db.createObjectStore(storeDef.name, {
        keyPath: storeDef.keyPath,
        autoIncrement: storeDef.autoIncrement ?? false,
      });

      // Create indexes
      if (storeDef.indexes) {
        for (const indexDef of storeDef.indexes) {
          try {
            store.createIndex(indexDef.name, indexDef.keyPath, {
              unique: indexDef.unique ?? false,
            });
          } catch {
            // Index might already exist
          }
        }
      }
    }
  }
}

/**
 * Create a shared IndexedDB database
 *
 * This function creates a database with all the stores needed for multiple packages.
 * Pass the returned database instance to each package's store.
 *
 * @example
 * ```typescript
 * import { createSharedDatabase } from '@imani/nostr-vouchers';
 * import { VoucherStore } from '@imani/nostr-vouchers';
 * // If auto-redemption is available:
 * // import { AUTO_REDEMPTION_STORE_DEFINITIONS } from '@imani/auto-redemption';
 *
 * const db = await createSharedDatabase({
 *   dbName: 'imani-wallet',
 *   additionalStores: AUTO_REDEMPTION_STORE_DEFINITIONS, // if available
 * });
 *
 * const voucherStore = new VoucherStore({ database: db });
 * await voucherStore.init();
 * ```
 */
export async function createSharedDatabase(
  config: SharedDatabaseConfig = {}
): Promise<IDBDatabase> {
  const dbName = config.dbName ?? DEFAULT_SHARED_DB_NAME;
  const version = config.version ?? DEFAULT_SHARED_DB_VERSION;
  const additionalStores = config.additionalStores ?? [];

  if (typeof indexedDB === 'undefined') {
    throw new StorageError(
      'IndexedDB is not available in this environment',
      ErrorCodes.DATABASE_NOT_AVAILABLE
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, version);

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
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create voucher stores
      createStoresFromDefinitions(db, VOUCHER_STORE_DEFINITIONS);

      // Create any additional stores from other packages
      if (additionalStores.length > 0) {
        createStoresFromDefinitions(db, additionalStores);
      }
    };
  });
}

/**
 * Open an existing shared database without creating new stores
 *
 * This is useful when you want to connect to an existing database
 * that was created by another package.
 */
export async function openSharedDatabase(
  dbName: string = DEFAULT_SHARED_DB_NAME
): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new StorageError(
      'IndexedDB is not available in this environment',
      ErrorCodes.DATABASE_NOT_AVAILABLE
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);

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
      const db = request.result;

      // Verify required stores exist
      if (!db.objectStoreNames.contains(STORES.VOUCHERS)) {
        db.close();
        reject(
          new StorageError(
            `Database "${dbName}" does not contain required voucher stores. ` +
              'Use createSharedDatabase() to create a new database with all required stores.',
            ErrorCodes.STORAGE_NOT_INITIALIZED
          )
        );
        return;
      }

      resolve(db);
    };
  });
}

/**
 * Check if a shared database exists
 */
export async function sharedDatabaseExists(
  dbName: string = DEFAULT_SHARED_DB_NAME
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') {
    return false;
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(dbName);

    request.onsuccess = () => {
      const db = request.result;
      const exists = db.objectStoreNames.contains(STORES.VOUCHERS);
      db.close();
      resolve(exists);
    };

    request.onerror = () => {
      resolve(false);
    };
  });
}

/**
 * Delete a shared database
 */
export async function deleteSharedDatabase(
  dbName: string = DEFAULT_SHARED_DB_NAME
): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    throw new StorageError(
      'IndexedDB is not available in this environment',
      ErrorCodes.DATABASE_NOT_AVAILABLE
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);

    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(
        new StorageError(
          `Failed to delete database: ${request.error?.message}`,
          ErrorCodes.STORAGE_DELETE_FAILED
        )
      );
  });
}

/**
 * Get information about a shared database
 */
export async function getSharedDatabaseInfo(
  dbName: string = DEFAULT_SHARED_DB_NAME
): Promise<{
  name: string;
  version: number;
  stores: string[];
} | null> {
  if (typeof indexedDB === 'undefined') {
    return null;
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(dbName);

    request.onsuccess = () => {
      const db = request.result;
      const info = {
        name: db.name,
        version: db.version,
        stores: Array.from(db.objectStoreNames),
      };
      db.close();
      resolve(info);
    };

    request.onerror = () => {
      resolve(null);
    };
  });
}

/**
 * Upgrade a shared database to add new stores
 *
 * This is a helper for migrations when you need to add stores from a new package.
 * The database must be closed before calling this function.
 */
export async function upgradeSharedDatabase(
  config: SharedDatabaseConfig & { newVersion: number }
): Promise<IDBDatabase> {
  const dbName = config.dbName ?? DEFAULT_SHARED_DB_NAME;
  const additionalStores = config.additionalStores ?? [];

  if (typeof indexedDB === 'undefined') {
    throw new StorageError(
      'IndexedDB is not available in this environment',
      ErrorCodes.DATABASE_NOT_AVAILABLE
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, config.newVersion);

    request.onerror = () => {
      reject(
        new StorageError(
          `Failed to upgrade IndexedDB: ${request.error?.message}`,
          ErrorCodes.STORAGE_OPEN_FAILED,
          { cause: request.error ?? undefined }
        )
      );
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Ensure voucher stores exist
      createStoresFromDefinitions(db, VOUCHER_STORE_DEFINITIONS);

      // Create additional stores
      if (additionalStores.length > 0) {
        createStoresFromDefinitions(db, additionalStores);
      }
    };
  });
}
