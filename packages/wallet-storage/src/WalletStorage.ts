/**
 * WalletStorage — IDB-backed wallet voucher + transaction store.
 *
 * Closes finding #4 of the 2026-05-16 redemption-path code review (the
 * RMW race on localStorage.imani_vouchers / localStorage.imani_transactions)
 * by moving each write into a single IDB transaction. Cross-tab consumers
 * are notified via the BroadcastChannel; their shadow caches mark stale
 * lazily (see `shared/walletStorageIntegration.js`).
 *
 * See specs/024-vouchers-tx-idb-migration/contracts/wallet-storage.contract.md.
 */

import {
  WalletStorageInvalidTokenError,
  WalletStorageNotInitializedError,
} from './errors';
import {
  STORES,
  WALLET_STORAGE_STORE_DEFINITIONS,
  type StoreDefinition,
} from './schema';
import { createBroadcastChannel, type BroadcastChannelLike } from './broadcastChannel';
import { looksLikeCashuToken, tokenIdFrom, safeTokenPrefix } from './tokenId';
import type {
  VoucherRow,
  TransactionRow,
  WalletStorageEvent,
  WalletStorageConfig,
} from './types';

const DEFAULT_DB_BASE_NAME = 'imani-wallet';
const DEFAULT_DB_VERSION = 2;

export class WalletStorage {
  private readonly config: WalletStorageConfig;
  private readonly tabId: string;
  private readonly now: () => number;

  private db: IDBDatabase | null = null;
  private ownsDb = false;
  private channel: BroadcastChannelLike | null = null;
  private listeners: Set<(event: WalletStorageEvent) => void> = new Set();
  private unsubscribeChannel: (() => void) | null = null;
  private initialized = false;

  constructor(config: WalletStorageConfig) {
    this.config = config;
    this.tabId = generateTabId();
    this.now = config.now ?? (() => Date.now());
  }

  // === Initialization ===

  async init(): Promise<void> {
    if (this.initialized) return;

    if (this.config.db) {
      // Attach to a pre-opened DB (the bridge passes the shared DB here).
      this.db = this.config.db;
      this.ownsDb = false;
    } else {
      const userId = this.config.userId;
      if (!userId) {
        throw new Error(
          'WalletStorage.init: either config.db or config.userId must be provided'
        );
      }
      this.db = await openOwnDatabase(`${DEFAULT_DB_BASE_NAME}-${userId}`);
      this.ownsDb = true;
    }

    // Sanity check — required stores must exist (the shared-DB owner is
    // responsible for declaring WALLET_STORAGE_STORE_DEFINITIONS in
    // additionalStores; if absent we surface a clear error rather than
    // failing on the first put).
    for (const def of WALLET_STORAGE_STORE_DEFINITIONS) {
      if (!this.db.objectStoreNames.contains(def.name)) {
        throw new Error(
          `WalletStorage.init: required object store "${def.name}" missing. ` +
            `Pass WALLET_STORAGE_STORE_DEFINITIONS to createSharedDatabase's additionalStores.`
        );
      }
    }

    // Wire up the BroadcastChannel.
    this.channel = createBroadcastChannel({
      channel: this.config.broadcastChannel,
      channelName: this.config.channelName,
    });
    this.unsubscribeChannel = this.channel.subscribe((event) => {
      // Filter self-originated events (C-PKG-5).
      if (event.source === this.tabId) return;
      // Fan out to local listeners.
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // Listener errors are isolated.
        }
      }
    });

    this.initialized = true;
  }

  // === Voucher operations ===

  async saveVoucher(voucher: VoucherRow): Promise<VoucherRow> {
    this.ensureInitialized('saveVoucher');

    // Defense-in-depth: backstop the token shape at the substrate layer.
    if (voucher.token && !looksLikeCashuToken(voucher.token)) {
      throw new WalletStorageInvalidTokenError(
        'saveVoucher: token failed shape check',
        {
          token_length: voucher.token.length,
          token_prefix: safeTokenPrefix(voucher.token),
          source: 'saveVoucher_backstop',
        }
      );
    }

    // Auto-derive token_id when absent (C-PKG-7).
    let tokenId = voucher.token_id;
    if (!tokenId) {
      if (!voucher.token) {
        throw new WalletStorageInvalidTokenError(
          'saveVoucher: token_id absent and token also absent — cannot derive',
          {
            token_length: 0,
            token_prefix: '<missing>',
            source: 'tokenId_compute_failed',
          }
        );
      }
      tokenId = await tokenIdFrom(voucher.token);
    }

    const nowIso = new Date(this.now()).toISOString();

    // Read-merge-write inside a single readwrite transaction (C-PKG-2 idempotent merge).
    const db = this.db!;
    const merged = await new Promise<VoucherRow>((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readwrite');
      const store = tx.objectStore(STORES.VOUCHERS);
      const getReq = store.get(tokenId!);
      getReq.onerror = () => reject(getReq.error);
      getReq.onsuccess = () => {
        const existing = (getReq.result as VoucherRow | undefined) ?? null;
        const next: VoucherRow = mergeRow(existing, voucher, {
          token_id: tokenId!,
          created_at: existing?.created_at ?? nowIso,
          updated_at: nowIso,
        }) as VoucherRow;
        const putReq = store.put(next);
        putReq.onerror = () => reject(putReq.error);
        putReq.onsuccess = () => {
          // resolve only after the transaction commits (oncomplete).
        };
      };
      tx.oncomplete = () => {
        // Re-read the canonical merged row inside a fresh tx after commit.
        const readTx = db.transaction(STORES.VOUCHERS, 'readonly');
        const readReq = readTx.objectStore(STORES.VOUCHERS).get(tokenId!);
        readReq.onsuccess = () => resolve(readReq.result as VoucherRow);
        readReq.onerror = () => reject(readReq.error);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('saveVoucher: tx aborted'));
    });

    this.postEvent('vouchers:changed');
    return merged;
  }

  async getVoucher(tokenId: string): Promise<VoucherRow | null> {
    this.ensureInitialized('getVoucher');
    return getByKey<VoucherRow>(this.db!, STORES.VOUCHERS, tokenId);
  }

  async getVoucherByVoucherId(voucherId: string): Promise<VoucherRow | null> {
    this.ensureInitialized('getVoucherByVoucherId');
    return getByIndex<VoucherRow>(this.db!, STORES.VOUCHERS, 'by-voucher-id', voucherId);
  }

  /**
   * Spec 041 — look up a voucher row by its `purchase_id` provenance field
   * (SA-006). Used by the wallet UI after the spec-041 saga's
   * `VOUCHER_CREATED` SSE callback to find the locally-saved voucher
   * (which was written BEFORE the `/client-materialized` confirm per
   * the canonical save → confirm → flush order).
   *
   * Linear scan via {@link #getAllVouchers}; no IDB secondary index added
   * (plan.md M1). For typical wallets (< 1000 vouchers) this completes in
   * well under 10ms and is not on the loadtest hot path — the call fires
   * once per atomic purchase on the UI callback. If perf becomes a
   * concern in a future spec, a `by-purchase-id` index can be added
   * without breaking this method's signature.
   *
   * Returns `null` when no row matches OR when `purchaseId` is empty.
   * Throws only when the underlying IDB connection isn't initialized
   * (`ensureInitialized` guard) — same failure mode as every other
   * `WalletStorage` accessor.
   */
  async getVoucherByPurchaseId(purchaseId: string): Promise<VoucherRow | null> {
    this.ensureInitialized('getVoucherByPurchaseId');
    if (!purchaseId) return null;
    const all = await this.getAllVouchers();
    for (const v of all) {
      if (v.purchase_id === purchaseId) return v;
    }
    return null;
  }

  async getAllVouchers(): Promise<VoucherRow[]> {
    this.ensureInitialized('getAllVouchers');
    return getAll<VoucherRow>(this.db!, STORES.VOUCHERS);
  }

  async removeVoucher(tokenId: string): Promise<boolean> {
    this.ensureInitialized('removeVoucher');
    const existed = await this.getVoucher(tokenId);
    if (!existed) return false;
    await deleteByKey(this.db!, STORES.VOUCHERS, tokenId);
    this.postEvent('vouchers:changed');
    return true;
  }

  /**
   * Spec 025 — bulk remove. Deletes N rows from `wallet_vouchers` inside a
   * single readwrite IDB transaction; posts exactly ONE `vouchers:changed`
   * event after commit regardless of how many rows existed.
   *
   * Returns the count of rows that existed and were deleted. Input tokenIds
   * that did not match an existing row contribute 0 to the count.
   *
   * Empty input is a no-op: no transaction opened, no event posted, returns 0.
   *
   * Used by `shared/storage.js`'s bulk-remove writers (sites 1556, 1594).
   * Per spec 025 FR-001, data-model.md §1, contracts §1.2 C-PKG-BULK-1+.
   */
  async removeVouchers(tokenIds: string[]): Promise<number> {
    this.ensureInitialized('removeVouchers');
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) return 0;

    const db = this.db!;
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readwrite');
      const store = tx.objectStore(STORES.VOUCHERS);
      let removed = 0;
      // Read-check-delete each row inside the same transaction so the
      // returned count reflects rows that ACTUALLY existed.
      for (const id of tokenIds) {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          if (getReq.result) {
            const delReq = store.delete(id);
            delReq.onsuccess = () => { removed++; };
            delReq.onerror = () => reject(delReq.error);
          }
        };
        getReq.onerror = () => reject(getReq.error);
      }
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('removeVouchers: tx aborted'));
    });

    this.postEvent('vouchers:changed');
    return count;
  }

  /**
   * Spec 025 — atomic replace-all. Clears `wallet_vouchers` and inserts the
   * given rows inside a single readwrite IDB transaction; posts exactly ONE
   * `vouchers:changed` event after commit.
   *
   * On any per-row put failure (e.g., a row missing `token_id`), the
   * transaction aborts and the store's prior contents are preserved.
   *
   * Empty input clears the store (intentional — matches the restore-from-
   * backup semantics where the new backup happens to be empty).
   *
   * Used by `shared/storage.js`'s restore-from-backup writer (site 6561).
   * Per spec 025 FR-002, data-model.md §1, contracts §1.2 C-PKG-BULK-2+.
   */
  async clearAndReplaceAllVouchers(rows: VoucherRow[]): Promise<void> {
    this.ensureInitialized('clearAndReplaceAllVouchers');
    const db = this.db!;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES.VOUCHERS, 'readwrite');
      const store = tx.objectStore(STORES.VOUCHERS);
      const clearReq = store.clear();
      clearReq.onerror = () => reject(clearReq.error);
      clearReq.onsuccess = () => {
        for (const row of rows) {
          const putReq = store.put(row);
          putReq.onerror = () => reject(putReq.error);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('clearAndReplaceAllVouchers: tx aborted'));
    });

    this.postEvent('vouchers:changed');
  }

  // === Transaction operations ===

  async addTransaction(tx: TransactionRow): Promise<TransactionRow> {
    this.ensureInitialized('addTransaction');
    const merged = await upsertRow<TransactionRow>(
      this.db!,
      STORES.TRANSACTIONS,
      tx.id,
      tx,
      { id: tx.id }
    );
    this.postEvent('transactions:changed');
    return merged;
  }

  async updateTransaction(
    id: string,
    patch: Partial<TransactionRow>
  ): Promise<TransactionRow | null> {
    this.ensureInitialized('updateTransaction');
    const existing = await this.getTransaction(id);
    if (!existing) return null;
    const merged = await upsertRow<TransactionRow>(
      this.db!,
      STORES.TRANSACTIONS,
      id,
      patch as TransactionRow,
      { id }
    );
    this.postEvent('transactions:changed');
    return merged;
  }

  async getTransaction(id: string): Promise<TransactionRow | null> {
    this.ensureInitialized('getTransaction');
    return getByKey<TransactionRow>(this.db!, STORES.TRANSACTIONS, id);
  }

  async getTransactionsByVoucher(voucherId: string): Promise<TransactionRow[]> {
    this.ensureInitialized('getTransactionsByVoucher');
    return getAllByIndex<TransactionRow>(
      this.db!,
      STORES.TRANSACTIONS,
      'by-voucher-id',
      voucherId
    );
  }

  async getAllTransactions(): Promise<TransactionRow[]> {
    this.ensureInitialized('getAllTransactions');
    return getAll<TransactionRow>(this.db!, STORES.TRANSACTIONS);
  }

  async removeTransaction(id: string): Promise<boolean> {
    this.ensureInitialized('removeTransaction');
    const existed = await this.getTransaction(id);
    if (!existed) return false;
    await deleteByKey(this.db!, STORES.TRANSACTIONS, id);
    this.postEvent('transactions:changed');
    return true;
  }

  /**
   * Spec 025 (T030) — atomic bulk-remove. Single readwrite IDB transaction
   * deletes every row whose `id` is in `ids`; returns the count of rows that
   * ACTUALLY existed (matching the voucher-side `removeVouchers` contract).
   * Posts exactly ONE `transactions:changed` event after commit.
   *
   * Used by `shared/storage.js` for compactions / multi-row deletes where
   * one event-per-row would over-fire downstream cache invalidations.
   */
  async removeTransactions(ids: string[]): Promise<number> {
    this.ensureInitialized('removeTransactions');
    if (!Array.isArray(ids) || ids.length === 0) return 0;

    const db = this.db!;
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORES.TRANSACTIONS, 'readwrite');
      const store = tx.objectStore(STORES.TRANSACTIONS);
      let removed = 0;
      for (const id of ids) {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          if (getReq.result) {
            const delReq = store.delete(id);
            delReq.onsuccess = () => { removed++; };
            delReq.onerror = () => reject(delReq.error);
          }
        };
        getReq.onerror = () => reject(getReq.error);
      }
      tx.oncomplete = () => resolve(removed);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('removeTransactions: tx aborted'));
    });

    this.postEvent('transactions:changed');
    return count;
  }

  /**
   * Spec 025 (T030) — atomic replace-all. Clears `wallet_transactions` and
   * inserts the given rows inside a single readwrite IDB transaction; posts
   * exactly ONE `transactions:changed` event after commit. Mirrors
   * `clearAndReplaceAllVouchers` semantics.
   *
   * Used by `shared/storage.js`'s `restoreTransactions` writer (site 9686)
   * and `updateTransactionsByVoucherId` bulk-update writer (site 9554).
   */
  async clearAndReplaceAllTransactions(rows: TransactionRow[]): Promise<void> {
    this.ensureInitialized('clearAndReplaceAllTransactions');
    const db = this.db!;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES.TRANSACTIONS, 'readwrite');
      const store = tx.objectStore(STORES.TRANSACTIONS);
      const clearReq = store.clear();
      clearReq.onerror = () => reject(clearReq.error);
      clearReq.onsuccess = () => {
        for (const row of rows) {
          const putReq = store.put(row);
          putReq.onerror = () => reject(putReq.error);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('clearAndReplaceAllTransactions: tx aborted'));
    });

    this.postEvent('transactions:changed');
  }

  // === Atomic write (spec 038 FR-014) ===

  /**
   * Spec-038 FR-014 — atomic voucher + transaction write.
   *
   * Commits N voucher rows AND M transaction rows inside a single
   * `readwrite` IDB transaction spanning both stores. Either ALL rows
   * land (transaction committed) or NONE do (transaction aborted, both
   * stores untouched). This closes the FR-019 "voucher saved but tx
   * write failed" partial-state class — by construction it cannot
   * happen post-spec-038.
   *
   * <p><b>Auto-derivation</b>: per parity with {@link saveVoucher},
   * voucher rows without `token_id` get one computed from `token` via
   * spec-017's `tokenIdFrom(token)` (a hash) BEFORE the IDB transaction
   * opens. If both fields are missing on any voucher, the call rejects
   * with {@link WalletStorageInvalidTokenError} and no write is
   * attempted (transaction never opens).
   *
   * <p><b>Token shape check</b>: each voucher's `token` (when present)
   * is passed through `looksLikeCashuToken` — a malformed token
   * rejects pre-transaction with {@link WalletStorageInvalidTokenError}.
   *
   * <p><b>Read-merge-write</b>: each voucher is merged with the
   * existing row (if any) by `token_id` — created_at preserved on
   * existing rows, updated_at refreshed. Transactions are merged by
   * `id`. Same idempotent semantics as the single-row writers.
   *
   * <p><b>Events</b>: posts exactly one `vouchers:changed` AND one
   * `transactions:changed` event AFTER the transaction commits. If
   * the call wrote zero vouchers (or zero transactions), the
   * corresponding event is NOT posted. If the transaction aborts,
   * neither event posts.
   *
   * @param input.vouchers Vouchers to write. May be empty (no-op for
   *                       this store).
   * @param input.transactions Transactions to write. May be empty
   *                           (no-op for this store).
   * @throws WalletStorageInvalidTokenError when any voucher fails
   *         the shape check or cannot derive a token_id.
   * @throws Error (the IDB error or 'atomicallyWrite: tx aborted')
   *         when the IDB transaction itself aborts/errors.
   */
  async atomicallyWrite(input: {
    vouchers?: VoucherRow[];
    transactions?: TransactionRow[];
  }): Promise<void> {
    this.ensureInitialized('atomicallyWrite');
    const vouchers = input.vouchers ?? [];
    const transactions = input.transactions ?? [];
    if (vouchers.length === 0 && transactions.length === 0) {
      return; // No-op.
    }

    const nowIso = new Date(this.now()).toISOString();

    // === Pre-transaction validation + token_id derivation ===
    //
    // We MUST resolve all token_ids BEFORE opening the IDB transaction.
    // tokenIdFrom() awaits SubtleCrypto.digest, and IDB transactions
    // auto-close at the end of the microtask after the last request
    // resolves — an `await` inside the transaction's callback would
    // close the transaction before the put() runs.
    const resolvedVouchers: VoucherRow[] = [];
    for (const voucher of vouchers) {
      // Type-guarded length/prefix to keep the documented contract:
      // a non-string `token` value (untyped JS caller) must still raise
      // WalletStorageInvalidTokenError without itself throwing on
      // `.length` (Copilot review #296 — E).
      if (voucher.token !== undefined && voucher.token !== null) {
        const tok = voucher.token;
        const isString = typeof tok === 'string';
        if (!isString || !looksLikeCashuToken(tok)) {
          throw new WalletStorageInvalidTokenError(
            'atomicallyWrite: voucher token failed shape check',
            {
              token_length: isString ? tok.length : 0,
              token_prefix: isString ? safeTokenPrefix(tok) : '<non-string>',
              source: 'atomicallyWrite_backstop',
            }
          );
        }
      }
      let tokenId = voucher.token_id;
      if (!tokenId) {
        if (!voucher.token) {
          throw new WalletStorageInvalidTokenError(
            'atomicallyWrite: token_id absent and token also absent — cannot derive',
            {
              token_length: 0,
              token_prefix: '<missing>',
              source: 'tokenId_compute_failed',
            }
          );
        }
        tokenId = await tokenIdFrom(voucher.token);
      }
      resolvedVouchers.push({ ...voucher, token_id: tokenId });
    }

    const db = this.db!;
    const stores = [
      ...(vouchers.length ? [STORES.VOUCHERS] : []),
      ...(transactions.length ? [STORES.TRANSACTIONS] : []),
    ];

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      const voucherStore = vouchers.length ? tx.objectStore(STORES.VOUCHERS) : null;
      const txStore = transactions.length ? tx.objectStore(STORES.TRANSACTIONS) : null;

      // Per-request failures call `fail(err)` ONCE — sets the flag,
      // explicitly aborts the IDB transaction (deterministic rollback,
      // doesn't wait for IDB's implicit abort), and rejects the outer
      // Promise. Subsequent error callbacks see `failed === true` and
      // no-op (Copilot review #296 — H).
      let failed = false;
      const fail = (err: unknown) => {
        if (failed) return;
        failed = true;
        try { tx.abort(); } catch { /* IDB already aborted */ }
        reject(err);
      };

      // Voucher upsert: read-merge-write per voucher.
      for (const voucher of resolvedVouchers) {
        const getReq = voucherStore!.get(voucher.token_id);
        getReq.onerror = () => fail(getReq.error);
        getReq.onsuccess = () => {
          if (failed) return;
          const existing = (getReq.result as VoucherRow | undefined) ?? null;
          const next = mergeRow(existing, voucher, {
            token_id: voucher.token_id,
            created_at: existing?.created_at ?? nowIso,
            updated_at: nowIso,
          }) as VoucherRow;
          const putReq = voucherStore!.put(next);
          putReq.onerror = () => fail(putReq.error);
        };
      }

      // Transaction upsert: read-merge-write per row.
      for (const txRow of transactions) {
        const getReq = txStore!.get(txRow.id);
        getReq.onerror = () => fail(getReq.error);
        getReq.onsuccess = () => {
          if (failed) return;
          const existing = (getReq.result as TransactionRow | undefined) ?? null;
          const next = mergeRow(existing, txRow, { id: txRow.id }) as TransactionRow;
          const putReq = txStore!.put(next);
          putReq.onerror = () => fail(putReq.error);
        };
      }

      tx.oncomplete = () => { if (!failed) resolve(); };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error ?? new Error('atomicallyWrite: tx aborted'));
    });

    // Post events AFTER commit, only for stores that received rows.
    if (vouchers.length > 0) this.postEvent('vouchers:changed');
    if (transactions.length > 0) this.postEvent('transactions:changed');
  }

  // === Cross-tab events ===

  onChange(listener: (event: WalletStorageEvent) => void): () => void {
    this.ensureInitialized('onChange');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    if (this.unsubscribeChannel) {
      this.unsubscribeChannel();
      this.unsubscribeChannel = null;
    }
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.listeners.clear();
    if (this.db && this.ownsDb) {
      this.db.close();
    }
    this.db = null;
    this.initialized = false;
  }

  // === Internals ===

  private ensureInitialized(operation: string): void {
    if (!this.initialized || !this.db) {
      throw new WalletStorageNotInitializedError(operation);
    }
  }

  private postEvent(type: WalletStorageEvent['type']): void {
    if (!this.channel) return;
    const event: WalletStorageEvent = {
      type,
      source: this.tabId,
      ts: this.now(),
    };
    this.channel.post(event);
  }

  /** Re-export — useful for consumers that want to inspect the schema. */
  static get STORE_DEFINITIONS(): readonly StoreDefinition[] {
    return WALLET_STORAGE_STORE_DEFINITIONS;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function generateTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient runtimes.
  return `tab-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Merge an existing IDB row with an incoming patch + the canonical
 * fields (token_id / id, created_at, updated_at). Fields with
 * `undefined` values in the input do NOT overwrite existing values
 * (idempotent partial-update semantics matching `shared/storage.js:3791`).
 * Fields with explicit `null` DO overwrite.
 */
function mergeRow(
  existing: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
  canonical: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  // Canonical fields always win.
  for (const [k, v] of Object.entries(canonical)) {
    out[k] = v;
  }
  return out;
}

function getByKey<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

function getByIndex<T>(
  db: IDBDatabase,
  storeName: string,
  indexName: string,
  key: IDBValidKey
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index(indexName).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

function getAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

function getAllByIndex<T>(
  db: IDBDatabase,
  storeName: string,
  indexName: string,
  key: IDBValidKey
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index(indexName).getAll(key);
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error);
  });
}

function deleteByKey(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => {
      // wait for tx.oncomplete to guarantee commit
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('deleteByKey: tx aborted'));
  });
}

async function upsertRow<T extends Record<string, unknown>>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  incoming: T,
  canonical: Record<string, unknown>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const getReq = store.get(key);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = (getReq.result as Record<string, unknown> | undefined) ?? null;
      const next = mergeRow(existing, incoming, canonical) as T;
      const putReq = store.put(next);
      putReq.onerror = () => reject(putReq.error);
    };
    tx.oncomplete = () => {
      const readTx = db.transaction(storeName, 'readonly');
      const readReq = readTx.objectStore(storeName).get(key);
      readReq.onsuccess = () => resolve(readReq.result as T);
      readReq.onerror = () => reject(readReq.error);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('upsertRow: tx aborted'));
  });
}

/**
 * Open an IDB connection with the wallet-storage stores defined.
 * Used only when the consumer didn't pre-open the DB via
 * `createSharedDatabase`. Mirrors the upgrade flow there but only
 * creates wallet-storage stores (doesn't touch nostr-vouchers').
 */
function openOwnDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('WalletStorage: indexedDB is not available in this realm'));
      return;
    }
    const req = indexedDB.open(dbName, DEFAULT_DB_VERSION);
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
