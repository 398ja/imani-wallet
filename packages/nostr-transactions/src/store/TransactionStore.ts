/**
 * TransactionStore - Main storage class for transactions
 *
 * Wraps storage adapters and provides a clean API for transaction management.
 */

import type {
  Transaction,
  TransactionInput,
  TransactionUpdate,
  TransactionFilter,
  TransactionQueryResult,
  TransactionStats,
} from '../types';
import { TransactionType } from '../types';
import type { FullStorageAdapter } from '../adapters/StorageAdapter';
import { IndexedDBAdapter } from '../adapters/IndexedDBAdapter';
import { MemoryAdapter } from '../adapters/MemoryAdapter';
import { TransactionQuery } from '../query/TransactionQuery';

/**
 * Storage adapter type
 */
export type StorageType = 'indexeddb' | 'memory';

/**
 * TransactionStore configuration
 */
export interface TransactionStoreConfig {
  /** Storage type to use */
  storage?: StorageType;
  /** Database name for IndexedDB */
  dbName?: string;
  /** Custom storage adapter (overrides storage type) */
  adapter?: FullStorageAdapter;
}

/**
 * TransactionStore - manages transaction storage
 */
export class TransactionStore {
  private adapter: FullStorageAdapter;
  private initialized = false;

  constructor(config: TransactionStoreConfig = {}) {
    if (config.adapter) {
      this.adapter = config.adapter;
    } else {
      const storageType = config.storage ?? 'indexeddb';
      switch (storageType) {
        case 'memory':
          this.adapter = new MemoryAdapter();
          break;
        case 'indexeddb':
        default:
          this.adapter = new IndexedDBAdapter({ dbName: config.dbName });
          break;
      }
    }
  }

  /**
   * Initialize the store
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.adapter.init();
    this.initialized = true;
  }

  /**
   * Close the store
   */
  async close(): Promise<void> {
    await this.adapter.close();
    this.initialized = false;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the underlying adapter
   */
  getAdapter(): FullStorageAdapter {
    return this.adapter;
  }

  // ==================== CRUD Operations ====================

  /**
   * Record a new transaction
   */
  async record(input: TransactionInput): Promise<Transaction> {
    this.ensureInitialized();
    return this.adapter.add(input);
  }

  /**
   * Upsert a bundle-aware transaction (spec 012-multi-voucher-send).
   *
   * Idempotent on the logical key (direction, bundleId): if a transaction with the same
   * direction and bundleId already exists, it is updated in place (bundle counters
   * recomputed); otherwise a fresh record is created.
   *
   * Per data-model.md "Modified entity: Transaction record":
   *   - On the receiver side, this is the path used to collapse N parts into one
   *     entry per bundle. bundleReceivedAmount, bundleState, bundlePartCount and
   *     bundleDeclaredTotal can change across calls (FR-017a/b idempotency,
   *     FR-018a first-write-wins on declared values).
   *   - On the sender side, a single completion call produces one outgoing record.
   *
   * The lookup uses adapter.getAll() and an in-memory filter on (direction, bundleId).
   * This is acceptable because (a) bundles are rare, (b) only ≤25 in-flight per user,
   * and (c) avoids extending the storage adapter contract.
   *
   * @param input - Transaction input. MUST carry bundleId; otherwise throws.
   * @returns The upserted transaction (existing or new).
   */
  async upsertBundleRecord(input: TransactionInput): Promise<Transaction> {
    this.ensureInitialized();
    if (!input.bundleId) {
      throw new Error('upsertBundleRecord requires input.bundleId');
    }
    if (!input.direction) {
      throw new Error('upsertBundleRecord requires input.direction');
    }

    const all = await this.adapter.getAll();
    const existing = all.find(
      (t) => t.bundleId === input.bundleId && t.direction === input.direction
    );

    if (!existing) {
      // Fresh bundle row. Carry an explicit faceValue equal to the declared total or
      // the running received amount, whichever is more meaningful for first creation.
      const newInput: TransactionInput = {
        ...input,
        // For the first part to land, faceValue defaults to whatever the caller passed
        // (typically the running bundleReceivedAmount), so the row already reads
        // truthfully even before all parts arrive.
        faceValue: input.faceValue,
      };
      return this.adapter.add(newInput);
    }

    // Merge bundle counters into the existing row.
    const update: TransactionUpdate = {};
    if (input.bundleReceivedAmount !== undefined) {
      update.bundleReceivedAmount = input.bundleReceivedAmount;
    }
    if (input.bundleState !== undefined) {
      update.bundleState = input.bundleState;
    }
    // First-write-wins on the immutable declared fields (FR-018a).
    // Only set them if absent on existing.
    if (existing.bundlePartCount === undefined && input.bundlePartCount !== undefined) {
      update.bundlePartCount = input.bundlePartCount;
    }
    if (existing.bundleDeclaredTotal === undefined && input.bundleDeclaredTotal !== undefined) {
      update.bundleDeclaredTotal = input.bundleDeclaredTotal;
    }
    if (input.memo !== undefined) {
      update.memo = input.memo;
    }
    return this.adapter.update(existing.id, update);
  }

  /**
   * Record multiple transactions in a batch
   */
  async recordBatch(inputs: TransactionInput[]): Promise<Transaction[]> {
    this.ensureInitialized();
    return this.adapter.addBatch(inputs);
  }

  /**
   * Get a transaction by ID
   */
  async get(id: string): Promise<Transaction | null> {
    this.ensureInitialized();
    return this.adapter.get(id);
  }

  /**
   * Get a transaction by Nostr event ID
   */
  async getByEventId(eventId: string): Promise<Transaction | null> {
    this.ensureInitialized();
    return this.adapter.getByEventId(eventId);
  }

  /**
   * Update a transaction
   */
  async update(id: string, update: TransactionUpdate): Promise<Transaction> {
    this.ensureInitialized();
    return this.adapter.update(id, update);
  }

  // ==================== Delivery confirmation (spec 014) ====================
  //
  // markDelivered() flips a sender-side single-voucher row to confirmed.
  // applyBundlePartReceipt() increments bundle counters and flips the
  // bundle row to partial / confirmed when the threshold is crossed.
  //
  // Both are idempotent and respect FR-010's no-downgrade invariant.
  // On a real change they emit a `transactionUpdated` event on the store
  // (lightweight EventTarget — listeners attach via on/off below).

  /**
   * Mark a single-voucher sent transaction as delivered.
   *
   * @param id          Transaction id (NOT voucherId — caller looks up first).
   * @param deliveredAt Unix seconds; preserved verbatim on first transition.
   * @returns The updated row, or null if the row was not found OR was
   *          already 'confirmed' (idempotent no-op).
   */
  async markDelivered(id: string, deliveredAt: number): Promise<Transaction | null> {
    this.ensureInitialized();
    const existing = await this.adapter.get(id);
    if (!existing) return null;
    if (existing.deliveryState === 'confirmed') return null;
    const update: TransactionUpdate = {
      deliveryState: 'confirmed',
      deliveredAt,
    };
    const next = await this.adapter.update(id, update);
    this.emitTransactionUpdated(next);
    return next;
  }

  /**
   * Apply a single bundle part receipt — increments deliveryConfirmedParts
   * (clamped at bundlePartCount) and recomputes deliveryState.
   *
   * @param id          Bundle row's transaction id.
   * @param partVoucherId The voucherId of the just-received part. Used to
   *                    dedupe within the bundle: passing the same voucherId
   *                    twice is a no-op.
   * @param deliveredAt Unix seconds; the timestamp set on the bundle row when
   *                    (and only when) it transitions to 'confirmed'.
   * @returns The updated row, or null if the row was not found, was not a
   *          bundle row, was already 'confirmed', or the part was already
   *          counted (idempotent no-op).
   */
  async applyBundlePartReceipt(
    id: string,
    partVoucherId: string,
    deliveredAt: number,
  ): Promise<Transaction | null> {
    this.ensureInitialized();
    const existing = await this.adapter.get(id);
    if (!existing) return null;
    if (!existing.bundleId) return null;
    if (existing.deliveryState === 'confirmed') return null;
    const partCount = existing.bundlePartCount ?? 0;
    if (partCount <= 0) return null;

    const meta = (existing.metadata ?? {}) as Record<string, unknown>;
    const seenRaw = meta['deliveryConfirmedVoucherIds'];
    const seen: string[] = Array.isArray(seenRaw)
      ? (seenRaw as string[]).slice()
      : [];
    if (seen.includes(partVoucherId)) return null;
    seen.push(partVoucherId);

    const nextCount = Math.min(seen.length, partCount);
    const isFull = nextCount >= partCount;
    const update: TransactionUpdate = {
      deliveryConfirmedParts: nextCount,
      deliveryState: isFull ? 'confirmed' : 'partial',
      metadata: { ...meta, deliveryConfirmedVoucherIds: seen },
    };
    if (isFull) {
      update.deliveredAt = deliveredAt;
    }
    const next = await this.adapter.update(id, update);
    this.emitTransactionUpdated(next);
    return next;
  }

  // ==================== Event emitter ====================
  //
  // Tiny pub/sub for spec-014 listeners (SenderListener in T034 listens
  // for `transactionUpdated` to drive late-binding sweeps; UI renderers
  // listen to refresh badge state). Built on EventTarget — zero-dep.

  private readonly events = new EventTarget();

  /**
   * Subscribe to store events. Returns an unsubscribe function.
   */
  on(
    type: 'transactionUpdated',
    listener: (transaction: Transaction) => void,
  ): () => void {
    const handler: EventListener = (e) =>
      listener((e as CustomEvent<Transaction>).detail);
    this.events.addEventListener(type, handler);
    return () => this.events.removeEventListener(type, handler);
  }

  private emitTransactionUpdated(transaction: Transaction): void {
    this.events.dispatchEvent(
      new CustomEvent<Transaction>('transactionUpdated', { detail: transaction }),
    );
  }

  /**
   * Delete a transaction
   */
  async delete(id: string): Promise<boolean> {
    this.ensureInitialized();
    return this.adapter.delete(id);
  }

  /**
   * Delete multiple transactions
   */
  async deleteBatch(ids: string[]): Promise<number> {
    this.ensureInitialized();
    return this.adapter.deleteBatch(ids);
  }

  // ==================== Query Operations ====================

  /**
   * Query transactions with filters
   */
  async query(filter: TransactionFilter = {}): Promise<TransactionQueryResult> {
    this.ensureInitialized();
    return this.adapter.query(filter);
  }

  /**
   * Create a fluent query builder
   *
   * @example
   * ```typescript
   * const results = await store.find()
   *   .type(TransactionType.RECEIVED)
   *   .thisMonth()
   *   .minAmount(1000)
   *   .newest()
   *   .limit(10)
   *   .execute();
   * ```
   */
  find(): TransactionQuery {
    this.ensureInitialized();
    return new TransactionQuery(this);
  }

  /**
   * Get all transactions
   */
  async getAll(): Promise<Transaction[]> {
    this.ensureInitialized();
    return this.adapter.getAll();
  }

  /**
   * Get recent transactions
   */
  async getRecent(limit: number = 10): Promise<Transaction[]> {
    const result = await this.query({
      limit,
      sortBy: 'timestamp',
      sortOrder: 'desc',
    });
    return result.transactions;
  }

  /**
   * Get transactions by type
   */
  async getByType(type: TransactionType | TransactionType[], limit?: number): Promise<Transaction[]> {
    const filter: TransactionFilter = {
      type,
      sortBy: 'timestamp',
      sortOrder: 'desc',
    };
    if (limit !== undefined) {
      filter.limit = limit;
    }
    const result = await this.query(filter);
    return result.transactions;
  }

  /**
   * Get transactions by counterparty
   */
  async getByCounterparty(counterparty: string, limit?: number): Promise<Transaction[]> {
    const filter: TransactionFilter = {
      counterparty,
      sortBy: 'timestamp',
      sortOrder: 'desc',
    };
    if (limit !== undefined) {
      filter.limit = limit;
    }
    const result = await this.query(filter);
    return result.transactions;
  }

  /**
   * Count transactions
   */
  async count(filter?: TransactionFilter): Promise<number> {
    this.ensureInitialized();
    return this.adapter.count(filter);
  }

  /**
   * Check if a transaction exists
   */
  async exists(id: string): Promise<boolean> {
    this.ensureInitialized();
    return this.adapter.exists(id);
  }

  /**
   * Clear all transactions
   */
  async clear(): Promise<void> {
    this.ensureInitialized();
    await this.adapter.clear();
  }

  // ==================== Sync Operations ====================

  /**
   * Get unsynced transactions
   */
  async getUnsynced(): Promise<Transaction[]> {
    this.ensureInitialized();
    return this.adapter.getUnsynced();
  }

  /**
   * Mark transactions as synced
   */
  async markSynced(ids: string[], eventIds?: string[]): Promise<void> {
    this.ensureInitialized();
    return this.adapter.markSynced(ids, eventIds);
  }

  /**
   * Get sync metadata
   */
  async getSyncMeta(key: string): Promise<unknown> {
    this.ensureInitialized();
    return this.adapter.getSyncMeta(key);
  }

  /**
   * Set sync metadata
   */
  async setSyncMeta(key: string, value: unknown): Promise<void> {
    this.ensureInitialized();
    return this.adapter.setSyncMeta(key, value);
  }

  // ==================== Statistics ====================

  /**
   * Get transaction statistics
   */
  async getStats(filter?: TransactionFilter): Promise<TransactionStats> {
    this.ensureInitialized();

    const result = await this.query({
      ...filter,
      limit: 0, // Get count only first
    });

    // Fetch all matching transactions for stats calculation
    const allResult = await this.query({
      ...filter,
      limit: result.total,
      offset: 0,
    });

    const transactions = allResult.transactions;

    // Initialize stats
    const stats: TransactionStats = {
      totalIn: 0,
      totalOut: 0,
      totalInternal: 0,
      countIn: 0,
      countOut: 0,
      countInternal: 0,
      netFlow: 0,
      byType: {},
      byUnit: {},
    };

    // Calculate stats
    for (const tx of transactions) {
      // Direction totals
      switch (tx.direction) {
        case 'in':
          stats.totalIn += tx.tokenAmount;
          stats.countIn++;
          break;
        case 'out':
          stats.totalOut += tx.tokenAmount;
          stats.countOut++;
          break;
        case 'internal':
          stats.totalInternal += tx.tokenAmount;
          stats.countInternal++;
          break;
      }

      // By type
      if (!stats.byType[tx.type]) {
        stats.byType[tx.type] = { count: 0, total: 0 };
      }
      stats.byType[tx.type].count++;
      stats.byType[tx.type].total += tx.tokenAmount;

      // By unit
      if (!stats.byUnit[tx.faceUnit]) {
        stats.byUnit[tx.faceUnit] = {
          count: 0,
          totalFaceValue: 0,
          totalTokenAmount: 0,
        };
      }
      stats.byUnit[tx.faceUnit].count++;
      stats.byUnit[tx.faceUnit].totalFaceValue += tx.faceValue;
      stats.byUnit[tx.faceUnit].totalTokenAmount += tx.tokenAmount;
    }

    // Calculate net flow
    stats.netFlow = stats.totalIn - stats.totalOut;

    return stats;
  }

  // ==================== Private Helpers ====================

  /**
   * Ensure the store is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('TransactionStore not initialized. Call init() first.');
    }
  }
}

/**
 * Create a transaction store
 */
export function createTransactionStore(config?: TransactionStoreConfig): TransactionStore {
  return new TransactionStore(config);
}
