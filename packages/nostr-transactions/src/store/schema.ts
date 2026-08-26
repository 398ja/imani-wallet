/**
 * IndexedDB Schema for transaction storage
 */

/**
 * Database configuration
 */
export const DB_NAME = 'imani-transactions';
/**
 * v1 → v2 (spec 014, 2026-05-08): adds the by-delivery-state index on
 * `transactions` (sparse — only sender-side rows with `deliveryState`
 * set populate it) and the new `pending_receipts` store for the
 * late-binding window (FR-016 / data-model.md §2). Upgrade is purely
 * additive — no row rewrites; pre-014 records stay valid with
 * `deliveryState === undefined`.
 */
export const DB_VERSION = 2;

/**
 * Object store names
 */
export const STORES = {
  TRANSACTIONS: 'transactions',
  SYNC_METADATA: 'sync_metadata',
  // Spec 014 (T022): late-binding receipts that arrived before the
  // matching Transaction was synced into local storage.
  PENDING_RECEIPTS: 'pending_receipts',
} as const;

/**
 * Index definitions for the transactions store
 */
export const TRANSACTION_INDEXES = [
  { name: 'eventId', keyPath: 'eventId', unique: true },
  { name: 'type', keyPath: 'type', unique: false },
  { name: 'direction', keyPath: 'direction', unique: false },
  { name: 'timestamp', keyPath: 'timestamp', unique: false },
  { name: 'counterparty', keyPath: 'counterparty', unique: false },
  { name: 'issuerId', keyPath: 'issuerId', unique: false },
  { name: 'walletId', keyPath: 'walletId', unique: false },
  { name: 'voucherId', keyPath: 'voucherId', unique: false },
  { name: 'synced', keyPath: 'synced', unique: false },
  { name: 'faceUnit', keyPath: 'faceUnit', unique: false },
  // Compound indexes for common queries
  { name: 'type_timestamp', keyPath: ['type', 'timestamp'], unique: false },
  { name: 'direction_timestamp', keyPath: ['direction', 'timestamp'], unique: false },
  { name: 'walletId_timestamp', keyPath: ['walletId', 'timestamp'], unique: false },
  { name: 'synced_timestamp', keyPath: ['synced', 'timestamp'], unique: false },
  // Spec 014 (T021): sparse index — only rows with deliveryState set
  // populate it. Used by the badge renderer to query unconfirmed sent
  // transactions and by the late-binding sweeper.
  { name: 'by-delivery-state', keyPath: 'deliveryState', unique: false },
] as const;

/**
 * Index definitions for the pending_receipts store (spec 014, T022).
 * Late-binding window: receipts that arrive before their matching
 * Transaction is locally available, retained up to 24 h then evicted.
 * See data-model.md §2 for sweep policy.
 */
export const PENDING_RECEIPT_INDEXES = [
  { name: 'by-voucher-id', keyPath: 'voucherId', unique: false },
  { name: 'by-received-at', keyPath: 'receivedAt', unique: false },
] as const;

/**
 * Sync metadata keys
 */
export const SYNC_METADATA_KEYS = {
  LAST_SYNC: 'lastSync',
  LAST_PUSH: 'lastPush',
  LAST_PULL: 'lastPull',
  LAST_EVENT_ID: 'lastEventId',
} as const;

/**
 * Index definition type
 */
export interface IndexDefinition {
  name: string;
  keyPath: string | string[];
  unique: boolean;
}

/**
 * Create database schema (called during upgrade)
 */
export function createSchema(db: IDBDatabase): void {
  // Create transactions store
  if (!db.objectStoreNames.contains(STORES.TRANSACTIONS)) {
    const txStore = db.createObjectStore(STORES.TRANSACTIONS, { keyPath: 'id' });

    // Create indexes
    for (const index of TRANSACTION_INDEXES) {
      txStore.createIndex(index.name, index.keyPath, { unique: index.unique });
    }
  }

  // Create sync metadata store
  if (!db.objectStoreNames.contains(STORES.SYNC_METADATA)) {
    db.createObjectStore(STORES.SYNC_METADATA, { keyPath: 'key' });
  }

  // Create pending_receipts store (spec 014 T022).
  if (!db.objectStoreNames.contains(STORES.PENDING_RECEIPTS)) {
    const pendingStore = db.createObjectStore(STORES.PENDING_RECEIPTS, {
      keyPath: 'receiptId',
    });
    for (const index of PENDING_RECEIPT_INDEXES) {
      pendingStore.createIndex(index.name, index.keyPath, { unique: index.unique });
    }
  }
}

/**
 * Upgrade database schema. Each branch is purely additive — no row
 * rewrites — so pre-existing data stays valid across upgrades.
 */
export function upgradeSchema(
  db: IDBDatabase,
  oldVersion: number,
  _newVersion: number | null,
  transaction: IDBTransaction
): void {
  // Version 0 -> 1: Initial schema
  if (oldVersion < 1) {
    createSchema(db);
  }

  // Version 1 -> 2 (spec 014, 2026-05-08):
  //   - add `by-delivery-state` index on the existing transactions store
  //     (sparse — pre-014 rows have deliveryState===undefined and stay
  //     out of the index).
  //   - create the `pending_receipts` store + its two indexes.
  if (oldVersion < 2) {
    if (db.objectStoreNames.contains(STORES.TRANSACTIONS)) {
      const txStore = transaction.objectStore(STORES.TRANSACTIONS);
      if (!txStore.indexNames.contains('by-delivery-state')) {
        txStore.createIndex('by-delivery-state', 'deliveryState', { unique: false });
      }
    }
    if (!db.objectStoreNames.contains(STORES.PENDING_RECEIPTS)) {
      const pendingStore = db.createObjectStore(STORES.PENDING_RECEIPTS, {
        keyPath: 'receiptId',
      });
      for (const index of PENDING_RECEIPT_INDEXES) {
        pendingStore.createIndex(index.name, index.keyPath, { unique: index.unique });
      }
    }
  }

  // Future migrations:
  // if (oldVersion < 3) { ... }
}
