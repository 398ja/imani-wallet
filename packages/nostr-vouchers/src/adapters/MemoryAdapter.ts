/**
 * Memory Adapter
 *
 * In-memory implementation of the StorageAdapter interface.
 * Useful for testing and Node.js environments without IndexedDB.
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
import { NotFoundError } from '../errors';

/**
 * Memory adapter configuration
 */
export interface MemoryAdapterConfig extends StorageAdapterConfig {
  /** Initial vouchers to populate */
  initialVouchers?: Voucher[];
}

/**
 * Memory adapter implementation
 */
export class MemoryAdapter implements FullStorageAdapter {
  private vouchers: Map<string, Voucher> = new Map();
  private syncMeta: Map<string, unknown> = new Map();
  private _initialized: boolean = false;

  constructor(config: MemoryAdapterConfig = {}) {
    if (config.initialVouchers) {
      for (const voucher of config.initialVouchers) {
        this.vouchers.set(voucher.id, voucher);
      }
    }
  }

  async init(): Promise<void> {
    this._initialized = true;
  }

  async close(): Promise<void> {
    this._initialized = false;
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  // ==========================================
  // Voucher CRUD Operations
  // ==========================================

  async add(input: VoucherInput): Promise<Voucher> {
    const voucher = createVoucher(input);
    this.vouchers.set(voucher.id, voucher);
    return voucher;
  }

  async addBatch(inputs: VoucherInput[]): Promise<Voucher[]> {
    const vouchers = inputs.map((input) => {
      const voucher = createVoucher(input);
      this.vouchers.set(voucher.id, voucher);
      return voucher;
    });
    return vouchers;
  }

  async get(id: string): Promise<Voucher | null> {
    return this.vouchers.get(id) ?? null;
  }

  async getByEventId(eventId: string): Promise<Voucher | null> {
    for (const voucher of this.vouchers.values()) {
      if (voucher.eventId === eventId) {
        return voucher;
      }
    }
    return null;
  }

  async update(id: string, update: VoucherUpdate): Promise<Voucher> {
    const existing = this.vouchers.get(id);
    if (!existing) {
      throw new NotFoundError(id);
    }

    const updated: Voucher = {
      ...existing,
      ...update,
      updatedAt: new Date().toISOString(),
    };

    this.vouchers.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.vouchers.delete(id);
  }

  async deleteBatch(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (this.vouchers.delete(id)) {
        deleted++;
      }
    }
    return deleted;
  }

  async query(filter: VoucherFilter): Promise<VoucherQueryResult> {
    const normalized = normalizeFilter(filter);
    const allVouchers = Array.from(this.vouchers.values());

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
    return Array.from(this.vouchers.values());
  }

  async count(filter?: VoucherFilter): Promise<number> {
    if (!filter) {
      return this.vouchers.size;
    }

    const normalized = normalizeFilter(filter);
    const allVouchers = Array.from(this.vouchers.values());
    return allVouchers.filter((v) => matchesFilter(v, normalized)).length;
  }

  async exists(id: string): Promise<boolean> {
    return this.vouchers.has(id);
  }

  async clear(): Promise<void> {
    this.vouchers.clear();
  }

  async getUnsynced(): Promise<Voucher[]> {
    return Array.from(this.vouchers.values()).filter((v) => !v.synced);
  }

  async markSynced(ids: string[], eventIds?: string[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    ids.forEach((id, index) => {
      const voucher = this.vouchers.get(id);
      if (voucher) {
        voucher.synced = true;
        voucher.syncedAt = now;
        if (eventIds && eventIds[index]) {
          voucher.eventId = eventIds[index];
        }
        this.vouchers.set(id, voucher);
      }
    });
  }

  // ==========================================
  // Sync Metadata Operations
  // ==========================================

  async getSyncMeta(key: string): Promise<unknown> {
    return this.syncMeta.get(key);
  }

  async setSyncMeta(key: string, value: unknown): Promise<void> {
    this.syncMeta.set(key, value);
  }

  async getAllSyncMeta(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.syncMeta.entries()) {
      result[key] = value;
    }
    return result;
  }

  async clearSyncMeta(): Promise<void> {
    this.syncMeta.clear();
  }

  // ==========================================
  // Additional Utility Methods
  // ==========================================

  /**
   * Get vouchers by status
   */
  async getByStatus(status: string): Promise<Voucher[]> {
    return Array.from(this.vouchers.values()).filter((v) => v.status === status);
  }

  /**
   * Get vouchers by issuer
   */
  async getByIssuer(issuerId: string): Promise<Voucher[]> {
    return Array.from(this.vouchers.values()).filter((v) => v.issuerId === issuerId);
  }

  /**
   * Get a snapshot of all data (useful for testing)
   */
  getSnapshot(): { vouchers: Voucher[]; syncMeta: Record<string, unknown> } {
    return {
      vouchers: Array.from(this.vouchers.values()),
      syncMeta: Object.fromEntries(this.syncMeta.entries()),
    };
  }

  /**
   * Load data from a snapshot (useful for testing)
   */
  loadSnapshot(snapshot: { vouchers: Voucher[]; syncMeta?: Record<string, unknown> }): void {
    this.vouchers.clear();
    this.syncMeta.clear();

    for (const voucher of snapshot.vouchers) {
      this.vouchers.set(voucher.id, voucher);
    }

    if (snapshot.syncMeta) {
      for (const [key, value] of Object.entries(snapshot.syncMeta)) {
        this.syncMeta.set(key, value);
      }
    }
  }
}

/**
 * Create a memory adapter instance
 */
export function createMemoryAdapter(config: MemoryAdapterConfig = {}): MemoryAdapter {
  return new MemoryAdapter(config);
}
