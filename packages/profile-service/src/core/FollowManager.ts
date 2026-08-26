import type {
  FollowAdapter,
  FollowEntry,
  AddFollowOptions,
  FollowList,
  FollowSyncStatus,
  ProfileEventEmitter,
} from '../types/index.js';
import { followSyncError } from '../types/errors.js';
import { isValidPubkey, normalizePubkey } from '../utils/validate.js';
import { SimpleEventEmitter, createEventHelpers } from '../utils/eventEmitter.js';

/** Stable ordering comparator for follow subsets (spec 044). */
function byOrder(a: FollowEntry, b: FollowEntry): number {
  return (a.order ?? a.createdAt) - (b.order ?? b.createdAt);
}

/**
 * Configuration for FollowManager
 */
export interface FollowManagerConfig {
  /** Follow adapter for persistence */
  adapter: FollowAdapter;
  /** Optional event emitter for follow events */
  eventEmitter?: ProfileEventEmitter;
  /** Enable optimistic updates (default: true) */
  optimisticUpdates?: boolean;
  /** Retry failed operations (default: true) */
  retryOnFailure?: boolean;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** The logged-in user's pubkey — never stored as a self-follow (spec 044). */
  selfPubkey?: string;
}

/**
 * FollowManager handles follow list CRUD operations with events and optimistic updates
 */
export class FollowManager {
  private readonly adapter: FollowAdapter;
  private readonly eventEmitter: ProfileEventEmitter;
  private readonly eventHelpers: ReturnType<typeof createEventHelpers>;
  private readonly optimisticUpdates: boolean;
  private readonly retryOnFailure: boolean;
  private readonly maxRetries: number;
  private readonly selfPubkey: string | null;

  /** In-memory follow list for optimistic updates */
  private followList: Map<string, FollowEntry> = new Map();
  /** Whether the list has been loaded */
  private loaded = false;
  /** Sync status tracking */
  private syncStatus: FollowSyncStatus = {
    syncing: false,
    pendingChanges: 0,
  };

  constructor(config: FollowManagerConfig) {
    this.adapter = config.adapter;
    this.eventEmitter = config.eventEmitter ?? new SimpleEventEmitter();
    this.eventHelpers = createEventHelpers(this.eventEmitter);
    this.optimisticUpdates = config.optimisticUpdates ?? true;
    this.retryOnFailure = config.retryOnFailure ?? true;
    this.maxRetries = config.maxRetries ?? 3;
    this.selfPubkey = config.selfPubkey && isValidPubkey(config.selfPubkey)
      ? normalizePubkey(config.selfPubkey)
      : null;
  }

  /**
   * Load the follow list from adapter
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    this.followList.clear();

    // Hydrate FULL entries when the adapter supports it (spec 044) so the
    // merchant discriminator + sync state survive a reload; fall back to a
    // pubkey-only list for adapters that don't.
    if (typeof this.adapter.listEntries === 'function') {
      const entries = await this.adapter.listEntries();
      for (const entry of entries) {
        this.followList.set(entry.pubkey, entry);
      }
    } else {
      const pubkeys = await this.adapter.list();
      for (const pubkey of pubkeys) {
        this.followList.set(pubkey, {
          pubkey,
          labels: [],
          createdAt: Date.now(),
          source: 'local',
          merchant: 'unknown',
          merchantCheckedAt: null,
          syncState: 'synced',
        });
      }
    }

    this.loaded = true;
  }

  /**
   * Get list of followed pubkeys
   */
  async list(): Promise<string[]> {
    await this.ensureLoaded();
    return Array.from(this.followList.keys());
  }

  /**
   * Get full follow entries with metadata
   */
  async listEntries(): Promise<FollowEntry[]> {
    await this.ensureLoaded();
    return Array.from(this.followList.values());
  }

  /**
   * Get a full follow entry, or null if not followed (spec 044).
   */
  async getEntry(pubkey: string): Promise<FollowEntry | null> {
    if (!isValidPubkey(pubkey)) return null;
    await this.ensureLoaded();
    return this.followList.get(normalizePubkey(pubkey)) ?? null;
  }

  /**
   * Followed CUSTOMERS subset (spec 044). `unknown` merchant status is treated
   * as customer (fail-open) until resolved. No network — reads in-memory only.
   * Ordered by the stable `order` key.
   */
  async listCustomers(): Promise<FollowEntry[]> {
    await this.ensureLoaded();
    return Array.from(this.followList.values())
      .filter((e) => (e.merchant ?? 'unknown') !== 'merchant')
      .sort(byOrder);
  }

  /**
   * Followed MERCHANTS subset (spec 044). Only entries confirmed as merchants.
   */
  async listMerchants(): Promise<FollowEntry[]> {
    await this.ensureLoaded();
    return Array.from(this.followList.values())
      .filter((e) => e.merchant === 'merchant')
      .sort(byOrder);
  }

  /**
   * Set the merchant discriminator on a followed entry (spec 044). Updates the
   * in-memory entry and persists via the adapter when supported.
   */
  async setMerchant(pubkey: string, merchant: FollowEntry['merchant'], checkedAt: number = Date.now()): Promise<void> {
    if (!isValidPubkey(pubkey)) return;
    await this.ensureLoaded();
    const normalized = normalizePubkey(pubkey);
    const entry = this.followList.get(normalized);
    if (!entry) return;
    entry.merchant = merchant;
    entry.merchantCheckedAt = checkedAt;
    if (typeof this.adapter.setMerchant === 'function') {
      try {
        await this.adapter.setMerchant(normalized, merchant ?? 'unknown', checkedAt);
      } catch {
        /* in-memory already updated; persistence is best-effort here */
      }
    }
  }

  /**
   * Persist a denormalized kind-0 profile snapshot on a followed entry (spec 044
   * #2). Updates the in-memory entry and persists via the adapter when supported,
   * so the followed list renders from the local store without a server hit.
   */
  async setProfile(
    pubkey: string,
    snapshot: { displayName?: string | null; picture?: string | null; nip05?: string | null },
    updatedAt: number = Date.now()
  ): Promise<void> {
    if (!isValidPubkey(pubkey)) return;
    await this.ensureLoaded();
    const normalized = normalizePubkey(pubkey);
    const entry = this.followList.get(normalized);
    if (!entry) return;
    if (snapshot.displayName !== undefined) entry.displayName = snapshot.displayName;
    if (snapshot.picture !== undefined) entry.picture = snapshot.picture;
    if (snapshot.nip05 !== undefined) entry.nip05 = snapshot.nip05;
    entry.profileUpdatedAt = updatedAt;
    if (typeof this.adapter.setProfile === 'function') {
      try {
        await this.adapter.setProfile(normalized, snapshot, updatedAt);
      } catch {
        /* in-memory already updated; persistence is best-effort here */
      }
    }
  }

  /**
   * Get follow list with metadata
   */
  async getFollowList(): Promise<FollowList> {
    await this.ensureLoaded();
    return {
      follows: Array.from(this.followList.values()),
      lastSyncedAt: this.syncStatus.lastSyncedAt,
      hasPendingSync: this.syncStatus.pendingChanges > 0,
    };
  }

  /**
   * Check if a pubkey is followed
   */
  async isFollowing(pubkey: string): Promise<boolean> {
    if (!isValidPubkey(pubkey)) return false;

    await this.ensureLoaded();
    const normalized = normalizePubkey(pubkey);
    return this.followList.has(normalized);
  }

  /**
   * Follow a pubkey
   */
  async follow(pubkey: string, options: AddFollowOptions = {}): Promise<void> {
    const normalized = normalizePubkey(pubkey);

    // Never store a self-follow (spec 044 FR-015 / data-model rule).
    if (this.selfPubkey && normalized === this.selfPubkey) {
      return;
    }

    await this.ensureLoaded();

    // Check if already following
    if (this.followList.has(normalized)) {
      // Update labels if provided
      if (options.labels) {
        const existing = this.followList.get(normalized)!;
        existing.labels = options.labels;
      }
      return;
    }

    const now = Date.now();
    const source = options.source ?? 'local';
    const labels = options.labels ?? [];
    const entry: FollowEntry = {
      pubkey: normalized,
      labels,
      createdAt: now,
      source,
      merchant: 'unknown',
      merchantCheckedAt: null,
      addedAt: now,
      order: now,
      syncState: 'pending-publish',
    };

    // Optimistic update
    if (this.optimisticUpdates) {
      this.followList.set(normalized, entry);
      this.eventHelpers.emitFollowAdded(normalized, entry.labels);
    }

    // Persist to adapter
    try {
      await this.persistFollow(normalized, { source, labels, order: now });

      // If not optimistic, update now
      if (!this.optimisticUpdates) {
        this.followList.set(normalized, entry);
        this.eventHelpers.emitFollowAdded(normalized, entry.labels);
      }

      this.syncStatus.lastSyncedAt = Date.now();
    } catch (error) {
      // Rollback on failure
      if (this.optimisticUpdates) {
        this.followList.delete(normalized);
        this.eventHelpers.emitFollowRemoved(normalized);
      }

      this.handleSyncError('follow', error);
      throw error;
    }
  }

  /**
   * Unfollow a pubkey
   */
  async unfollow(pubkey: string): Promise<void> {
    const normalized = normalizePubkey(pubkey);

    await this.ensureLoaded();

    // Check if not following
    if (!this.followList.has(normalized)) {
      return;
    }

    const previousEntry = this.followList.get(normalized);

    // Optimistic update
    if (this.optimisticUpdates) {
      this.followList.delete(normalized);
      this.eventHelpers.emitFollowRemoved(normalized);
    }

    // Persist to adapter
    try {
      await this.persistUnfollow(normalized);

      // If not optimistic, update now
      if (!this.optimisticUpdates) {
        this.followList.delete(normalized);
        this.eventHelpers.emitFollowRemoved(normalized);
      }

      this.syncStatus.lastSyncedAt = Date.now();
    } catch (error) {
      // Rollback on failure
      if (this.optimisticUpdates && previousEntry) {
        this.followList.set(normalized, previousEntry);
        this.eventHelpers.emitFollowAdded(normalized, previousEntry.labels);
      }

      this.handleSyncError('unfollow', error);
      throw error;
    }
  }

  /**
   * Toggle follow status
   * @returns true if now following, false if unfollowed
   */
  async toggle(pubkey: string, options: AddFollowOptions = {}): Promise<boolean> {
    const isCurrentlyFollowing = await this.isFollowing(pubkey);

    if (isCurrentlyFollowing) {
      await this.unfollow(pubkey);
      return false;
    } else {
      await this.follow(pubkey, options);
      return true;
    }
  }

  /**
   * Add labels to a followed pubkey
   */
  async addLabels(pubkey: string, labels: string[]): Promise<void> {
    const normalized = normalizePubkey(pubkey);

    await this.ensureLoaded();

    const entry = this.followList.get(normalized);
    if (!entry) {
      throw followSyncError(`Not following ${pubkey}`);
    }

    const existingLabels = new Set(entry.labels ?? []);
    labels.forEach((label) => existingLabels.add(label));
    entry.labels = Array.from(existingLabels);
  }

  /**
   * Remove labels from a followed pubkey
   */
  async removeLabels(pubkey: string, labels: string[]): Promise<void> {
    const normalized = normalizePubkey(pubkey);

    await this.ensureLoaded();

    const entry = this.followList.get(normalized);
    if (!entry) {
      throw followSyncError(`Not following ${pubkey}`);
    }

    const labelsToRemove = new Set(labels);
    entry.labels = (entry.labels ?? []).filter((l) => !labelsToRemove.has(l));
  }

  /**
   * Get follows by label
   */
  async getByLabel(label: string): Promise<FollowEntry[]> {
    await this.ensureLoaded();

    return Array.from(this.followList.values()).filter((entry) =>
      entry.labels?.includes(label)
    );
  }

  /**
   * Clear all follows
   */
  async clear(): Promise<void> {
    await this.ensureLoaded();

    const pubkeys = Array.from(this.followList.keys());

    if (this.adapter.clear) {
      await this.adapter.clear();
    } else {
      // Remove one by one
      for (const pubkey of pubkeys) {
        await this.adapter.remove(pubkey);
      }
    }

    // Emit events for each removed follow
    for (const pubkey of pubkeys) {
      this.eventHelpers.emitFollowRemoved(pubkey);
    }

    this.followList.clear();
    this.syncStatus.lastSyncedAt = Date.now();
  }

  /**
   * Get sync status
   */
  getSyncStatus(): FollowSyncStatus {
    return { ...this.syncStatus };
  }

  /**
   * Subscribe to follow events
   */
  on(listener: Parameters<ProfileEventEmitter['on']>[0]): () => void {
    return this.eventEmitter.on(listener);
  }

  /**
   * Invalidate the in-memory cache so the next read re-hydrates from the
   * adapter (spec 044) — called after the sync coordinator mutates the store
   * directly, so subset reads reflect the converged state.
   */
  invalidate(): void {
    this.loaded = false;
  }

  /**
   * Ensure the follow list is loaded
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  /**
   * Persist follow to adapter with retry
   */
  private async persistFollow(pubkey: string, opts?: Parameters<FollowAdapter['add']>[1]): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        await this.adapter.add(pubkey, opts);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.retryOnFailure || attempt === this.maxRetries - 1) {
          throw lastError;
        }

        // Wait before retry (exponential backoff)
        await this.delay(Math.pow(2, attempt) * 100);
      }
    }

    throw lastError;
  }

  /**
   * Persist unfollow to adapter with retry
   */
  private async persistUnfollow(pubkey: string): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        await this.adapter.remove(pubkey);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.retryOnFailure || attempt === this.maxRetries - 1) {
          throw lastError;
        }

        // Wait before retry (exponential backoff)
        await this.delay(Math.pow(2, attempt) * 100);
      }
    }

    throw lastError;
  }

  /**
   * Handle sync error
   */
  private handleSyncError(operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.syncStatus.lastError = `${operation} failed: ${message}`;
    this.eventHelpers.emitFollowSyncError(this.syncStatus.lastError, true);
  }

  /**
   * Delay helper for retry backoff
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a FollowManager instance
 */
export function createFollowManager(config: FollowManagerConfig): FollowManager {
  return new FollowManager(config);
}
