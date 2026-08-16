/**
 * VoucherStore - Main store class for voucher management
 *
 * Combines storage adapter with event emission and expiry checking.
 */

import type {
  Voucher,
  VoucherInput,
  VoucherUpdate,
  VoucherFilter,
  VoucherQueryResult,
  VoucherStats,
  VoucherEventType,
  EventHandler,
  Unsubscribe,
  SyncStatus,
} from '../types';
import {
  VoucherStatus,
  isVoucherExpired,
  matchesFilter,
  normalizeFilter,
} from '../types';
import type { FullStorageAdapter, StorageAdapterConfig } from '../adapters';
import { IndexedDBAdapter, MemoryAdapter } from '../adapters';
import { TypedEventEmitter } from '../utils';

/**
 * Storage type
 */
export type StorageType = 'indexeddb' | 'memory';

/**
 * VoucherStore configuration
 */
export interface VoucherStoreConfig extends StorageAdapterConfig {
  /** Storage type */
  storage?: StorageType;
  /** External database for shared database mode */
  database?: IDBDatabase;
  /** Check for expired vouchers on init */
  checkExpiryOnInit?: boolean;
  /** Expiry check interval in milliseconds (0 to disable) */
  expiryCheckInterval?: number;
  /** Days before expiry to emit warning */
  expiryWarningDays?: number[];
}

/**
 * VoucherStore class
 */
export class VoucherStore {
  private adapter: FullStorageAdapter;
  private emitter: TypedEventEmitter;
  private _initialized: boolean = false;
  private expiryCheckTimer: ReturnType<typeof setInterval> | null = null;
  private config: VoucherStoreConfig;

  constructor(config: VoucherStoreConfig = {}) {
    this.config = {
      storage: 'indexeddb',
      checkExpiryOnInit: true,
      expiryCheckInterval: 60000, // 1 minute
      expiryWarningDays: [7, 3, 1],
      ...config,
    };

    // Create appropriate adapter
    if (config.database) {
      // Shared database mode
      this.adapter = new IndexedDBAdapter({ database: config.database });
    } else if (this.config.storage === 'memory') {
      this.adapter = new MemoryAdapter();
    } else {
      this.adapter = new IndexedDBAdapter({
        dbName: config.dbName,
        version: config.version,
      });
    }

    this.emitter = new TypedEventEmitter();
  }

  /**
   * Initialize the store
   */
  async init(): Promise<void> {
    if (this._initialized) return;

    await this.adapter.init();
    this._initialized = true;

    // Emit store opened event
    this.emitter.emit('store:opened', {
      dbName: this.config.dbName ?? 'imani-vouchers',
      isShared: !!this.config.database,
    });

    // Check for expired vouchers
    if (this.config.checkExpiryOnInit) {
      await this.checkExpiredVouchers();
    }

    // Start expiry check interval
    if (this.config.expiryCheckInterval && this.config.expiryCheckInterval > 0) {
      this.startExpiryCheck();
    }
  }

  /**
   * Close the store
   */
  async close(): Promise<void> {
    this.stopExpiryCheck();
    await this.adapter.close();
    this._initialized = false;

    this.emitter.emit('store:closed', {
      dbName: this.config.dbName ?? 'imani-vouchers',
    });
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  // ==========================================
  // Event Subscription
  // ==========================================

  /**
   * Subscribe to an event
   */
  on<T extends VoucherEventType>(event: T, handler: EventHandler<T>): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  /**
   * Subscribe to an event (once)
   */
  once<T extends VoucherEventType>(event: T, handler: EventHandler<T>): Unsubscribe {
    return this.emitter.once(event, handler);
  }

  /**
   * Unsubscribe from an event
   */
  off<T extends VoucherEventType>(event: T, handler: EventHandler<T>): void {
    this.emitter.off(event, handler);
  }

  // ==========================================
  // CRUD Operations
  // ==========================================

  /**
   * Add a voucher
   */
  async add(input: VoucherInput): Promise<Voucher> {
    const voucher = await this.adapter.add(input);

    this.emitter.emit('voucher:added', {
      voucher,
      source: 'local',
    });

    return voucher;
  }

  /**
   * Add multiple vouchers
   */
  async addBatch(inputs: VoucherInput[]): Promise<Voucher[]> {
    const vouchers = await this.adapter.addBatch(inputs);

    this.emitter.emit('voucher:batch-added', {
      vouchers,
      count: vouchers.length,
      source: 'local',
    });

    return vouchers;
  }

  /**
   * Get a voucher by ID
   */
  async get(id: string): Promise<Voucher | null> {
    return this.adapter.get(id);
  }

  /**
   * Get a voucher by event ID
   */
  async getByEventId(eventId: string): Promise<Voucher | null> {
    return this.adapter.getByEventId(eventId);
  }

  /**
   * Update a voucher
   */
  async update(id: string, update: VoucherUpdate): Promise<Voucher> {
    const previous = await this.adapter.get(id);
    const voucher = await this.adapter.update(id, update);

    // Determine changed fields
    const changes: (keyof Voucher)[] = [];
    if (previous) {
      for (const key of Object.keys(update) as (keyof VoucherUpdate)[]) {
        if (previous[key] !== voucher[key]) {
          changes.push(key);
        }
      }
    }

    this.emitter.emit('voucher:updated', {
      voucher,
      previous: previous!,
      changes,
    });

    // Check for status changes
    if (previous && previous.status !== voucher.status) {
      if (voucher.status === VoucherStatus.SPENT) {
        this.emitter.emit('voucher:spent', {
          voucher,
          spentAt: voucher.updatedAt ?? new Date().toISOString(),
        });
      } else if (voucher.status === VoucherStatus.EXPIRED) {
        this.emitter.emit('voucher:expired', {
          voucher,
          expiredAt: voucher.expiresAt ?? new Date().toISOString(),
        });
      }
    }

    return voucher;
  }

  /**
   * Delete a voucher
   */
  async delete(id: string): Promise<boolean> {
    const voucher = await this.adapter.get(id);
    const deleted = await this.adapter.delete(id);

    if (deleted) {
      this.emitter.emit('voucher:deleted', {
        voucherId: id,
        voucher: voucher ?? undefined,
      });
    }

    return deleted;
  }

  /**
   * Delete multiple vouchers
   */
  async deleteBatch(ids: string[]): Promise<number> {
    return this.adapter.deleteBatch(ids);
  }

  // ==========================================
  // Query Operations
  // ==========================================

  /**
   * Query vouchers with filters
   */
  async query(filter: VoucherFilter = {}): Promise<VoucherQueryResult> {
    return this.adapter.query(filter);
  }

  /**
   * Get all vouchers
   */
  async getAll(): Promise<Voucher[]> {
    return this.adapter.getAll();
  }

  /**
   * Count vouchers
   */
  async count(filter?: VoucherFilter): Promise<number> {
    return this.adapter.count(filter);
  }

  /**
   * Check if a voucher exists
   */
  async exists(id: string): Promise<boolean> {
    return this.adapter.exists(id);
  }

  /**
   * Clear all vouchers
   */
  async clear(): Promise<void> {
    return this.adapter.clear();
  }

  // ==========================================
  // Specialized Queries
  // ==========================================

  /**
   * Get active vouchers
   */
  async getActive(): Promise<Voucher[]> {
    const result = await this.query({
      status: VoucherStatus.ACTIVE,
      includeExpired: false,
    });
    return result.vouchers;
  }

  /**
   * Get vouchers expiring within N days
   */
  async getExpiringSoon(days: number = 7): Promise<Voucher[]> {
    const result = await this.query({
      status: VoucherStatus.ACTIVE,
      expiringWithin: days,
    });
    return result.vouchers;
  }

  /**
   * Get vouchers by merchant
   */
  async getByMerchant(issuerId: string): Promise<Voucher[]> {
    const result = await this.query({
      issuerId,
      status: VoucherStatus.ACTIVE,
    });
    return result.vouchers;
  }

  /**
   * Get vouchers by currency
   */
  async getByCurrency(faceUnit: string): Promise<Voucher[]> {
    const result = await this.query({
      faceUnit,
      status: VoucherStatus.ACTIVE,
    });
    return result.vouchers;
  }

  /**
   * Get unsynced vouchers
   */
  async getUnsynced(): Promise<Voucher[]> {
    return this.adapter.getUnsynced();
  }

  /**
   * Mark vouchers as synced
   */
  async markSynced(ids: string[], eventIds?: string[]): Promise<void> {
    return this.adapter.markSynced(ids, eventIds);
  }

  // ==========================================
  // Statistics
  // ==========================================

  /**
   * Get voucher statistics
   */
  async getStats(options?: { filter?: VoucherFilter }): Promise<VoucherStats> {
    const allVouchers = await this.getAll();
    const filter = options?.filter;

    // Apply filter if provided
    const vouchers = filter
      ? allVouchers.filter((v) => matchesFilter(v, normalizeFilter(filter)))
      : allVouchers;

    // Calculate stats
    const totalFaceValue: Record<string, number> = {};
    let totalTokenAmount = 0;
    const byStatus: Record<string, number> = {};
    const byStrategy: Record<string, number> = {};
    const byCurrency: Record<string, number> = {};
    const merchantSet = new Set<string>();

    const now = new Date();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysFromNow = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    let expiringWithin7Days = 0;
    let expiringWithin30Days = 0;

    for (const voucher of vouchers) {
      // Total face value by currency
      totalFaceValue[voucher.faceUnit] =
        (totalFaceValue[voucher.faceUnit] ?? 0) + voucher.faceValue;

      // Total token amount
      totalTokenAmount += voucher.tokenAmount;

      // By status
      byStatus[voucher.status] = (byStatus[voucher.status] ?? 0) + 1;

      // By strategy
      byStrategy[voucher.backingStrategy] = (byStrategy[voucher.backingStrategy] ?? 0) + 1;

      // By currency
      byCurrency[voucher.faceUnit] = (byCurrency[voucher.faceUnit] ?? 0) + 1;

      // Merchants
      if (voucher.issuerId) {
        merchantSet.add(voucher.issuerId);
      }

      // Expiring soon
      if (voucher.expiresAt && voucher.status === VoucherStatus.ACTIVE) {
        const expiryDate = new Date(voucher.expiresAt);
        if (expiryDate <= sevenDaysFromNow && expiryDate > now) {
          expiringWithin7Days++;
        }
        if (expiryDate <= thirtyDaysFromNow && expiryDate > now) {
          expiringWithin30Days++;
        }
      }
    }

    return {
      totalVouchers: vouchers.length,
      totalFaceValue,
      totalTokenAmount,
      byStatus,
      byStrategy,
      byCurrency,
      expiringWithin7Days,
      expiringWithin30Days,
      merchantCount: merchantSet.size,
    };
  }

  // ==========================================
  // Sync Metadata
  // ==========================================

  /**
   * Get sync status
   */
  async getSyncStatus(): Promise<SyncStatus> {
    const lastSync = (await this.adapter.getSyncMeta('lastSync')) as number | null;
    const lastEventId = (await this.adapter.getSyncMeta('lastEventId')) as string | null;
    const isSyncing = (await this.adapter.getSyncMeta('isSyncing')) as boolean | undefined;
    const lastError = (await this.adapter.getSyncMeta('lastError')) as string | undefined;
    const unsynced = await this.getUnsynced();

    return {
      lastSync: lastSync ?? null,
      lastEventId: lastEventId ?? null,
      pendingCount: unsynced.length,
      isSyncing: isSyncing ?? false,
      lastError,
    };
  }

  /**
   * Set sync metadata
   */
  async setSyncMeta(key: string, value: unknown): Promise<void> {
    return this.adapter.setSyncMeta(key, value);
  }

  /**
   * Get sync metadata
   */
  async getSyncMeta(key: string): Promise<unknown> {
    return this.adapter.getSyncMeta(key);
  }

  // ==========================================
  // Expiry Checking
  // ==========================================

  /**
   * Start periodic expiry checking
   */
  private startExpiryCheck(): void {
    if (this.expiryCheckTimer) return;

    this.expiryCheckTimer = setInterval(() => {
      this.checkExpiredVouchers().catch((error) => {
        console.error('Error checking expired vouchers:', error);
      });
    }, this.config.expiryCheckInterval!);
  }

  /**
   * Stop periodic expiry checking
   */
  private stopExpiryCheck(): void {
    if (this.expiryCheckTimer) {
      clearInterval(this.expiryCheckTimer);
      this.expiryCheckTimer = null;
    }
  }

  /**
   * Check for expired vouchers and emit events
   */
  async checkExpiredVouchers(): Promise<void> {
    const vouchers = await this.getAll();
    const now = new Date();
    const warningDays = this.config.expiryWarningDays ?? [7, 3, 1];

    for (const voucher of vouchers) {
      if (voucher.status !== VoucherStatus.ACTIVE) continue;

      // Check if expired
      if (isVoucherExpired(voucher)) {
        // Update status to expired
        await this.update(voucher.id, { status: VoucherStatus.EXPIRED });
        continue;
      }

      // Check for expiry warnings
      if (voucher.expiresAt) {
        const expiryDate = new Date(voucher.expiresAt);
        const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        for (const warningDay of warningDays) {
          if (daysLeft === warningDay) {
            this.emitter.emit('voucher:expiring', {
              voucher,
              daysLeft,
              expiresAt: voucher.expiresAt,
            });
            break;
          }
        }
      }
    }
  }

  // ==========================================
  // Access to underlying adapter
  // ==========================================

  /**
   * Get the underlying storage adapter (for advanced use)
   */
  getAdapter(): FullStorageAdapter {
    return this.adapter;
  }
}

/**
 * Create a VoucherStore instance
 */
export function createVoucherStore(config: VoucherStoreConfig = {}): VoucherStore {
  return new VoucherStore(config);
}
