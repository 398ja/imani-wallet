/**
 * PendingReceiptStore — late-binding window for sender-side delivery
 * receipts that arrive before their matching Transaction is locally
 * available (spec 014, FR-016).
 *
 * Backed by the `pending_receipts` IDB object store added in schema
 * v2 (T021/T022). Operates against an already-open IDBDatabase so it
 * can share a single DB handle with TransactionStore — bridge code
 * (T032) wires the two together.
 *
 * Sweep policy (data-model.md §2):
 *   - On every transactionAdded, query by-voucher-id and apply matches.
 *   - 1-hour timer evicts entries with receivedAt < now() - 24h.
 *   - Capped at 1000 rows; oldest evicted on overflow (best-effort,
 *     enforced lazily during put).
 */

import { STORES } from './schema';

const MAX_ROWS = 1000;
const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Stored row shape. The `envelope` field carries the plaintext
 * (decrypted, validated) payment-receipt envelope. We store it as
 * `Record<string, unknown>` to avoid a cross-package type dependency on
 * @imani/payment-receipts; the bridge layer in T032 owns the cast on
 * the way out.
 */
export interface PendingReceiptRecord {
  receiptId: string;
  voucherId: string;
  envelope: Record<string, unknown>;
  receivedAt: number;
}

export class PendingReceiptStore {
  constructor(private readonly db: IDBDatabase) {}

  /**
   * Insert (or replace) a pending-receipt row. Best-effort overflow
   * eviction: if the store is at capacity, the oldest row by
   * receivedAt is dropped before the new row is inserted.
   */
  async put(record: PendingReceiptRecord): Promise<void> {
    return this.tx('readwrite', async (store) => {
      const count = await reqAsPromise(store.count());
      if (count >= MAX_ROWS) {
        // Evict the oldest row (by receivedAt index) — single forward
        // cursor walk; bounded by MAX_ROWS so still O(1) amortised.
        const idx = store.index('by-received-at');
        const cursor = await reqAsPromise<IDBCursorWithValue | null>(idx.openCursor());
        if (cursor) {
          const oldest = cursor.value as PendingReceiptRecord;
          await reqAsPromise(store.delete(oldest.receiptId));
        }
      }
      await reqAsPromise(store.put(record));
    });
  }

  /**
   * Look up all pending-receipt rows whose envelope is for the given
   * voucherId. In practice this returns 0 or 1 row, but the sender's
   * dedup cache lives elsewhere — the store itself does not enforce
   * uniqueness on (voucherId, _).
   */
  async findByVoucherId(voucherId: string): Promise<PendingReceiptRecord[]> {
    return this.tx('readonly', async (store) => {
      const idx = store.index('by-voucher-id');
      const records = await reqAsPromise<PendingReceiptRecord[]>(
        idx.getAll(voucherId),
      );
      return records ?? [];
    });
  }

  /**
   * Idempotent delete by primary key.
   */
  async delete(receiptId: string): Promise<void> {
    return this.tx('readwrite', async (store) => {
      await reqAsPromise(store.delete(receiptId));
    });
  }

  /**
   * Evict every row with `receivedAt < now() - maxAgeSeconds`.
   * Called on a 1-hour timer per data-model.md §2.
   *
   * @param now Override clock for tests (Unix seconds).
   * @param maxAgeSeconds Default 24 hours.
   * @returns Count of rows evicted.
   */
  async evictOlderThan(
    maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<number> {
    const cutoff = now - maxAgeSeconds;
    return this.tx('readwrite', async (store) => {
      const idx = store.index('by-received-at');
      const range = IDBKeyRange.upperBound(cutoff, true);
      const expired = await reqAsPromise<PendingReceiptRecord[]>(idx.getAll(range));
      let count = 0;
      for (const row of expired ?? []) {
        await reqAsPromise(store.delete(row.receiptId));
        count++;
      }
      return count;
    });
  }

  // ===== internals =====

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    if (!this.db.objectStoreNames.contains(STORES.PENDING_RECEIPTS)) {
      throw new Error(
        'PendingReceiptStore: IDB does not contain the pending_receipts store; ' +
          'is the schema at v2 or higher?',
      );
    }
    const transaction = this.db.transaction(STORES.PENDING_RECEIPTS, mode);
    const store = transaction.objectStore(STORES.PENDING_RECEIPTS);
    try {
      const result = await fn(store);
      return result;
    } finally {
      // Transactions auto-commit when all requests complete; nothing to do.
    }
  }
}

function reqAsPromise<T = unknown>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
