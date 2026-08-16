/**
 * In-memory storage adapter implementation
 *
 * Useful for testing and Node.js environments where IndexedDB is not available.
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

/**
 * Memory adapter configuration
 */
export interface MemoryAdapterConfig extends StorageAdapterConfig {
  /** Initial transactions to populate */
  initialData?: Transaction[];
}

/**
 * In-memory storage adapter
 */
export class MemoryAdapter implements FullStorageAdapter {
  private transactions: Map<string, Transaction> = new Map();
  private eventIdIndex: Map<string, string> = new Map(); // eventId -> id
  private syncMeta: Map<string, unknown> = new Map();
  private initialized = false;
  private readonly config: MemoryAdapterConfig;

  constructor(config: MemoryAdapterConfig = {}) {
    this.config = config;
  }

  /**
   * Initialize the storage
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Load initial data if provided
    if (this.config.initialData) {
      for (const tx of this.config.initialData) {
        this.transactions.set(tx.id, tx);
        if (tx.eventId) {
          this.eventIdIndex.set(tx.eventId, tx.id);
        }
      }
    }

    this.initialized = true;
  }

  /**
   * Close the storage
   */
  async close(): Promise<void> {
    this.initialized = false;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Ensure initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('Storage not initialized. Call init() first.');
    }
  }

  /**
   * Add a transaction
   */
  async add(input: TransactionInput): Promise<Transaction> {
    this.ensureInitialized();
    const tx = createTransaction(input);
    this.transactions.set(tx.id, tx);
    return tx;
  }

  /**
   * Add multiple transactions in a batch
   */
  async addBatch(inputs: TransactionInput[]): Promise<Transaction[]> {
    this.ensureInitialized();
    const transactions = inputs.map((input) => {
      const tx = createTransaction(input);
      this.transactions.set(tx.id, tx);
      return tx;
    });
    return transactions;
  }

  /**
   * Get a transaction by ID
   */
  async get(id: string): Promise<Transaction | null> {
    this.ensureInitialized();
    return this.transactions.get(id) ?? null;
  }

  /**
   * Get a transaction by event ID
   */
  async getByEventId(eventId: string): Promise<Transaction | null> {
    this.ensureInitialized();
    const id = this.eventIdIndex.get(eventId);
    if (!id) {
      return null;
    }
    return this.transactions.get(id) ?? null;
  }

  /**
   * Update a transaction
   */
  async update(id: string, update: TransactionUpdate): Promise<Transaction> {
    this.ensureInitialized();
    const existing = this.transactions.get(id);
    if (!existing) {
      throw new Error(`Transaction not found: ${id}`);
    }

    // Handle eventId index update
    if (update.eventId && update.eventId !== existing.eventId) {
      if (existing.eventId) {
        this.eventIdIndex.delete(existing.eventId);
      }
      this.eventIdIndex.set(update.eventId, id);
    }

    const updated: Transaction = {
      ...existing,
      ...update,
    };
    this.transactions.set(id, updated);
    return updated;
  }

  /**
   * Delete a transaction by ID
   */
  async delete(id: string): Promise<boolean> {
    this.ensureInitialized();
    const tx = this.transactions.get(id);
    if (!tx) {
      return false;
    }

    // Clean up eventId index
    if (tx.eventId) {
      this.eventIdIndex.delete(tx.eventId);
    }

    return this.transactions.delete(id);
  }

  /**
   * Delete multiple transactions
   */
  async deleteBatch(ids: string[]): Promise<number> {
    this.ensureInitialized();
    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) {
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * Query transactions with filters
   */
  async query(filter: TransactionFilter): Promise<TransactionQueryResult> {
    this.ensureInitialized();
    const normalizedFilter = normalizeFilter(filter);
    const { limit, offset, sortBy, sortOrder } = normalizedFilter;

    // Get all transactions
    let transactions = Array.from(this.transactions.values());

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
    this.ensureInitialized();
    return Array.from(this.transactions.values());
  }

  /**
   * Count transactions
   */
  async count(filter?: TransactionFilter): Promise<number> {
    this.ensureInitialized();
    if (!filter) {
      return this.transactions.size;
    }

    const normalizedFilter = normalizeFilter(filter);
    let count = 0;
    for (const tx of this.transactions.values()) {
      if (matchesFilter(tx, normalizedFilter)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Check if a transaction exists
   */
  async exists(id: string): Promise<boolean> {
    this.ensureInitialized();
    return this.transactions.has(id);
  }

  /**
   * Clear all transactions
   */
  async clear(): Promise<void> {
    this.ensureInitialized();
    this.transactions.clear();
    this.eventIdIndex.clear();
  }

  /**
   * Get unsynced transactions
   */
  async getUnsynced(): Promise<Transaction[]> {
    this.ensureInitialized();
    return Array.from(this.transactions.values()).filter((tx) => !tx.synced);
  }

  /**
   * Mark transactions as synced
   */
  async markSynced(ids: string[], eventIds?: string[]): Promise<void> {
    this.ensureInitialized();
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const tx = this.transactions.get(id);
      if (tx) {
        tx.synced = true;
        tx.syncedAt = now;
        if (eventIds && eventIds[i]) {
          if (tx.eventId) {
            this.eventIdIndex.delete(tx.eventId);
          }
          tx.eventId = eventIds[i];
          this.eventIdIndex.set(eventIds[i], id);
        }
      }
    }
  }

  // ==================== Sync Metadata ====================

  /**
   * Get sync metadata value
   */
  async getSyncMeta(key: string): Promise<unknown> {
    this.ensureInitialized();
    return this.syncMeta.get(key);
  }

  /**
   * Set sync metadata value
   */
  async setSyncMeta(key: string, value: unknown): Promise<void> {
    this.ensureInitialized();
    this.syncMeta.set(key, value);
  }

  /**
   * Get all sync metadata
   */
  async getAllSyncMeta(): Promise<Record<string, unknown>> {
    this.ensureInitialized();
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.syncMeta) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Clear sync metadata
   */
  async clearSyncMeta(): Promise<void> {
    this.ensureInitialized();
    this.syncMeta.clear();
  }
}

/**
 * Create a memory adapter
 */
export function createMemoryAdapter(config?: MemoryAdapterConfig): MemoryAdapter {
  return new MemoryAdapter(config);
}
