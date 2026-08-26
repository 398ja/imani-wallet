import type { FollowAdapter, FollowEntry, FollowProfileSnapshot, FollowSyncState, MerchantFlag } from '../types/index.js';
import { storageError } from '../types/errors.js';
import { normalizePubkey } from '../utils/validate.js';

/**
 * Configuration for LocalFollowAdapter
 */
export interface LocalFollowAdapterConfig {
  /** Database name */
  dbName?: string;
  /** Store name */
  storeName?: string;
}

/** Options for adding/upserting a follow entry (spec 044). */
export interface AddFollowEntryOptions {
  source?: FollowEntry['source'];
  merchant?: MerchantFlag;
  merchantCheckedAt?: number | null;
  syncState?: FollowSyncState;
  order?: number;
  relayHint?: string | null;
  petname?: string | null;
  labels?: string[];
  displayName?: string | null;
  picture?: string | null;
  nip05?: string | null;
  profileUpdatedAt?: number | null;
}

/** Schema version: 2 added the spec-044 follow fields + the `order` index. */
const DB_VERSION = 2;

/** NIP-02 petnames are display metadata only; bound their length defensively. */
const MAX_PETNAME_LENGTH = 80;

/**
 * Stored follow entry in IndexedDB (spec 044 extends with the merchant
 * discriminator, ordering, sync state, and preserved NIP-02 metadata).
 */
interface StoredFollowEntry {
  pubkey: string;
  labels: string[];
  createdAt: number;
  source: string;
  merchant: MerchantFlag;
  merchantCheckedAt: number | null;
  addedAt: number;
  order: number;
  syncState: FollowSyncState;
  relayHint: string | null;
  petname: string | null;
  displayName: string | null;
  picture: string | null;
  nip05: string | null;
  profileUpdatedAt: number | null;
}

function boundPetname(petname: string | null | undefined): string | null {
  if (typeof petname !== 'string' || petname.length === 0) return null;
  return petname.slice(0, MAX_PETNAME_LENGTH);
}

/** Map a stored row to a FollowEntry, defaulting fields absent on legacy rows. */
function toFollowEntry(r: StoredFollowEntry): FollowEntry {
  return {
    pubkey: r.pubkey,
    labels: r.labels ?? [],
    createdAt: r.createdAt,
    source: r.source as FollowEntry['source'],
    merchant: r.merchant ?? 'unknown',
    merchantCheckedAt: r.merchantCheckedAt ?? null,
    addedAt: r.addedAt ?? r.createdAt,
    order: typeof r.order === 'number' ? r.order : r.createdAt,
    syncState: r.syncState ?? 'synced',
    relayHint: r.relayHint ?? null,
    petname: r.petname ?? null,
    displayName: r.displayName ?? null,
    picture: r.picture ?? null,
    nip05: r.nip05 ?? null,
    profileUpdatedAt: r.profileUpdatedAt ?? null,
  };
}

/**
 * LocalFollowAdapter stores follows in IndexedDB for offline persistence
 */
export class LocalFollowAdapter implements FollowAdapter {
  private readonly dbName: string;
  private readonly storeName: string;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: LocalFollowAdapterConfig = {}) {
    this.dbName = config.dbName ?? 'profile-service-follows';
    this.storeName = config.storeName ?? 'follows';
  }

  /**
   * Initialize the database connection
   */
  private async init(): Promise<void> {
    if (this.db) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(storageError('IndexedDB is not available'));
        return;
      }

      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => {
        reject(storageError('Failed to open IndexedDB', request.error ?? undefined));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const tx = (event.target as IDBOpenDBRequest).transaction;
        const storeName = this.storeName;

        const store = db.objectStoreNames.contains(storeName)
          ? tx!.objectStore(storeName)
          : (() => {
              const s = db.createObjectStore(storeName, { keyPath: 'pubkey' });
              s.createIndex('createdAt', 'createdAt', { unique: false });
              s.createIndex('labels', 'labels', { unique: false, multiEntry: true });
              return s;
            })();

        if (!store.indexNames.contains('order')) {
          store.createIndex('order', 'order', { unique: false });
        }

        // Back-fill spec-044 fields onto any pre-existing (v1) rows.
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const row = cursor.value as Partial<StoredFollowEntry>;
          let changed = false;
          if (row.merchant === undefined) { row.merchant = 'unknown'; changed = true; }
          if (row.merchantCheckedAt === undefined) { row.merchantCheckedAt = null; changed = true; }
          if (row.addedAt === undefined) { row.addedAt = row.createdAt ?? Date.now(); changed = true; }
          if (row.order === undefined) { row.order = row.createdAt ?? Date.now(); changed = true; }
          if (row.syncState === undefined) { row.syncState = 'synced'; changed = true; }
          if (row.relayHint === undefined) { row.relayHint = null; changed = true; }
          if (row.petname === undefined) { row.petname = null; changed = true; }
          if (changed) cursor.update(row);
          cursor.continue();
        };
      };
    });

    return this.initPromise;
  }

  /**
   * Get a database transaction
   */
  private async getStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    await this.init();
    if (!this.db) {
      throw storageError('Database not initialized');
    }
    const transaction = this.db.transaction(this.storeName, mode);
    return transaction.objectStore(this.storeName);
  }

  /**
   * List all followed pubkeys
   */
  async list(): Promise<string[]> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.getAllKeys();

      request.onerror = () => {
        reject(storageError('Failed to list follows', request.error ?? undefined));
      };

      request.onsuccess = () => {
        resolve(request.result as string[]);
      };
    });
  }

  /**
   * Add a pubkey to follow list. `opts` lets callers (the sync coordinator /
   * importer) supply merchant status, ordering, sync state, and preserved
   * NIP-02 metadata; a bare local follow defaults to `pending-publish`.
   */
  async add(pubkey: string, opts: AddFollowEntryOptions = {}): Promise<void> {
    const normalized = normalizePubkey(pubkey); // throws on malformed (validation)
    const store = await this.getStore('readwrite');
    const now = Date.now();

    return new Promise((resolve, reject) => {
      const getRequest = store.get(normalized);
      getRequest.onerror = () => {
        reject(storageError('Failed to read follow for upsert', getRequest.error ?? undefined));
      };
      getRequest.onsuccess = () => {
        // Upsert: when the row already exists (e.g. a sync re-import), preserve
        // its resolved merchant flag and cached profile snapshot unless the
        // caller explicitly overrides them — never wipe them on re-add.
        const prev = getRequest.result as StoredFollowEntry | undefined;
        const entry: StoredFollowEntry = {
          pubkey: normalized,
          labels: opts.labels ?? prev?.labels ?? [],
          createdAt: prev?.createdAt ?? now,
          source: opts.source ?? prev?.source ?? 'local',
          merchant: opts.merchant ?? prev?.merchant ?? 'unknown',
          merchantCheckedAt: opts.merchantCheckedAt ?? prev?.merchantCheckedAt ?? null,
          addedAt: prev?.addedAt ?? now,
          order: typeof opts.order === 'number' ? opts.order : (prev?.order ?? now),
          syncState: opts.syncState ?? prev?.syncState ?? 'pending-publish',
          relayHint: opts.relayHint ?? prev?.relayHint ?? null,
          petname: opts.petname !== undefined ? boundPetname(opts.petname) : (prev?.petname ?? null),
          displayName: opts.displayName ?? prev?.displayName ?? null,
          picture: opts.picture ?? prev?.picture ?? null,
          nip05: opts.nip05 ?? prev?.nip05 ?? null,
          profileUpdatedAt: opts.profileUpdatedAt ?? prev?.profileUpdatedAt ?? null,
        };
        const putRequest = store.put(entry);
        putRequest.onerror = () => {
          reject(storageError('Failed to add follow', putRequest.error ?? undefined));
        };
        putRequest.onsuccess = () => resolve();
      };
    });
  }

  /**
   * Remove a pubkey from follow list
   */
  async remove(pubkey: string): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.delete(normalized);

      request.onerror = () => {
        reject(storageError('Failed to remove follow', request.error ?? undefined));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Clear all follows
   */
  async clear(): Promise<void> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onerror = () => {
        reject(storageError('Failed to clear follows', request.error ?? undefined));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Check if following a pubkey
   */
  async has(pubkey: string): Promise<boolean> {
    const normalized = normalizePubkey(pubkey);
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.get(normalized);

      request.onerror = () => {
        reject(storageError('Failed to check follow', request.error ?? undefined));
      };

      request.onsuccess = () => {
        resolve(request.result !== undefined);
      };
    });
  }

  /**
   * Get full follow entry
   */
  async getEntry(pubkey: string): Promise<FollowEntry | null> {
    const normalized = normalizePubkey(pubkey);
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.get(normalized);

      request.onerror = () => {
        reject(storageError('Failed to get follow entry', request.error ?? undefined));
      };

      request.onsuccess = () => {
        const result = request.result as StoredFollowEntry | undefined;
        resolve(result ? toFollowEntry(result) : null);
      };
    });
  }

  /**
   * Get all follow entries
   */
  async listEntries(): Promise<FollowEntry[]> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.getAll();

      request.onerror = () => {
        reject(storageError('Failed to list follow entries', request.error ?? undefined));
      };

      request.onsuccess = () => {
        const results = request.result as StoredFollowEntry[];
        resolve(results.map(toFollowEntry));
      };
    });
  }

  /**
   * Update labels for a follow entry
   */
  async updateLabels(pubkey: string, labels: string[]): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const getRequest = store.get(normalized);

      getRequest.onerror = () => {
        reject(storageError('Failed to get follow for update', getRequest.error ?? undefined));
      };

      getRequest.onsuccess = () => {
        const existing = getRequest.result as StoredFollowEntry | undefined;
        if (!existing) {
          reject(storageError('Follow entry not found'));
          return;
        }

        existing.labels = labels;
        const putRequest = store.put(existing);

        putRequest.onerror = () => {
          reject(storageError('Failed to update labels', putRequest.error ?? undefined));
        };

        putRequest.onsuccess = () => {
          resolve();
        };
      };
    });
  }

  /**
   * Set the merchant discriminator (+ checked-at) for a follow entry.
   */
  async setMerchant(pubkey: string, merchant: MerchantFlag, checkedAt: number = Date.now()): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const getRequest = store.get(normalized);
      getRequest.onerror = () => {
        reject(storageError('Failed to get follow for merchant update', getRequest.error ?? undefined));
      };
      getRequest.onsuccess = () => {
        const existing = getRequest.result as StoredFollowEntry | undefined;
        if (!existing) {
          resolve();
          return;
        }
        existing.merchant = merchant;
        existing.merchantCheckedAt = checkedAt;
        const putRequest = store.put(existing);
        putRequest.onerror = () => {
          reject(storageError('Failed to set merchant', putRequest.error ?? undefined));
        };
        putRequest.onsuccess = () => resolve();
      };
    });
  }

  /**
   * Persist a denormalized kind-0 profile snapshot on a followed entry (spec 044
   * #2), so the followed list renders from the local store without a server hit.
   * Only provided fields are updated; the refresh timestamp is always stamped.
   */
  async setProfile(
    pubkey: string,
    snapshot: FollowProfileSnapshot,
    updatedAt: number = Date.now()
  ): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const getRequest = store.get(normalized);
      getRequest.onerror = () => {
        reject(storageError('Failed to get follow for profile update', getRequest.error ?? undefined));
      };
      getRequest.onsuccess = () => {
        const existing = getRequest.result as StoredFollowEntry | undefined;
        if (!existing) {
          resolve();
          return;
        }
        if (snapshot.displayName !== undefined) existing.displayName = snapshot.displayName;
        if (snapshot.picture !== undefined) existing.picture = snapshot.picture;
        if (snapshot.nip05 !== undefined) existing.nip05 = snapshot.nip05;
        existing.profileUpdatedAt = updatedAt;
        const putRequest = store.put(existing);
        putRequest.onerror = () => {
          reject(storageError('Failed to set profile', putRequest.error ?? undefined));
        };
        putRequest.onsuccess = () => resolve();
      };
    });
  }

  /**
   * Get follows by label
   */
  async getByLabel(label: string): Promise<FollowEntry[]> {
    const store = await this.getStore('readonly');
    const index = store.index('labels');

    return new Promise((resolve, reject) => {
      const request = index.getAll(label);

      request.onerror = () => {
        reject(storageError('Failed to get follows by label', request.error ?? undefined));
      };

      request.onsuccess = () => {
        const results = request.result as StoredFollowEntry[];
        resolve(results.map(toFollowEntry));
      };
    });
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initPromise = null;
    }
  }
}

/**
 * In-memory follow adapter for testing
 */
export class MemoryFollowAdapter implements FollowAdapter {
  private follows: Map<string, FollowEntry> = new Map();

  async list(): Promise<string[]> {
    return Array.from(this.follows.keys());
  }

  async add(pubkey: string, opts: AddFollowEntryOptions = {}): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    const now = Date.now();
    // Upsert: preserve a resolved merchant flag + cached profile snapshot on re-add.
    const prev = this.follows.get(normalized);
    this.follows.set(normalized, {
      pubkey: normalized,
      labels: opts.labels ?? prev?.labels ?? [],
      createdAt: prev?.createdAt ?? now,
      source: (opts.source ?? prev?.source ?? 'local') as FollowEntry['source'],
      merchant: opts.merchant ?? prev?.merchant ?? 'unknown',
      merchantCheckedAt: opts.merchantCheckedAt ?? prev?.merchantCheckedAt ?? null,
      addedAt: prev?.addedAt ?? now,
      order: typeof opts.order === 'number' ? opts.order : (prev?.order ?? now),
      syncState: opts.syncState ?? prev?.syncState ?? 'pending-publish',
      relayHint: opts.relayHint ?? prev?.relayHint ?? null,
      petname: opts.petname !== undefined ? boundPetname(opts.petname) : (prev?.petname ?? null),
      displayName: opts.displayName ?? prev?.displayName ?? null,
      picture: opts.picture ?? prev?.picture ?? null,
      nip05: opts.nip05 ?? prev?.nip05 ?? null,
      profileUpdatedAt: opts.profileUpdatedAt ?? prev?.profileUpdatedAt ?? null,
    });
  }

  async remove(pubkey: string): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    this.follows.delete(normalized);
  }

  async clear(): Promise<void> {
    this.follows.clear();
  }

  async has(pubkey: string): Promise<boolean> {
    const normalized = normalizePubkey(pubkey);
    return this.follows.has(normalized);
  }

  async setMerchant(pubkey: string, merchant: MerchantFlag, checkedAt: number = Date.now()): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    const existing = this.follows.get(normalized);
    if (!existing) return;
    existing.merchant = merchant;
    existing.merchantCheckedAt = checkedAt;
  }

  async setProfile(
    pubkey: string,
    snapshot: FollowProfileSnapshot,
    updatedAt: number = Date.now()
  ): Promise<void> {
    const normalized = normalizePubkey(pubkey);
    const existing = this.follows.get(normalized);
    if (!existing) return;
    if (snapshot.displayName !== undefined) existing.displayName = snapshot.displayName;
    if (snapshot.picture !== undefined) existing.picture = snapshot.picture;
    if (snapshot.nip05 !== undefined) existing.nip05 = snapshot.nip05;
    existing.profileUpdatedAt = updatedAt;
  }

  async getEntry(pubkey: string): Promise<FollowEntry | null> {
    const normalized = normalizePubkey(pubkey);
    return this.follows.get(normalized) ?? null;
  }

  async listEntries(): Promise<FollowEntry[]> {
    return Array.from(this.follows.values());
  }

  // For testing - get all entries
  getAll(): FollowEntry[] {
    return Array.from(this.follows.values());
  }
}

/**
 * Create a LocalFollowAdapter instance
 */
export function createLocalFollowAdapter(
  config: LocalFollowAdapterConfig = {}
): LocalFollowAdapter {
  return new LocalFollowAdapter(config);
}
