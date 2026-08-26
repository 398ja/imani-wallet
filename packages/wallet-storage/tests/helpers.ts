/**
 * Test helpers shared across the wallet-storage vitest suites.
 *
 * The shared IDB DB is opened against fake-indexeddb (loaded via
 * vitest.config.ts's setupFiles). Each test gets its own DB name
 * (via `crypto.randomUUID()`) so suites don't cross-contaminate.
 */

import { WALLET_STORAGE_STORE_DEFINITIONS } from '../src/schema';

/**
 * Open a shared IDB DB containing only the wallet-storage stores.
 * Mirrors what `createSharedDatabase` would do at production boot
 * but doesn't drag the full @imani/nostr-vouchers dependency into
 * unit tests.
 */
export function openTestDatabase(dbName: string, version = 2): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, version);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const def of WALLET_STORAGE_STORE_DEFINITIONS) {
        if (db.objectStoreNames.contains(def.name)) continue;
        const store = db.createObjectStore(def.name, { keyPath: def.keyPath });
        for (const idx of def.indexes ?? []) {
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

/** Unique DB name per test to avoid cross-test contamination. */
export function uniqueDbName(prefix = 'walletstorage-test'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Build a minimal valid cashu V4 token string that passes the
 * `looksLikeCashuToken` backstop. The exact bytes don't matter for
 * these tests — we never decode them — only the shape.
 */
export function makeFakeCashuToken(seed = 'a'): string {
  // `cashuB` + 16+ base64-ish chars. 22-char minimum.
  return `cashuB${seed.repeat(16)}deadbeef`;
}
