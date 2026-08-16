import type { CacheStore, CacheConfig, CacheStats } from '../types/cache.js';
import { storageError } from '../types/errors.js';

interface StoredEntry<T> {
  key: string;
  value: T;
  cachedAt: number;
  ttlMs: number;
}

/**
 * IndexedDB-based cache store for offline persistence
 */
export class IndexedDBCacheStore<T = unknown> implements CacheStore<T> {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly defaultTtlMs: number;
  private readonly maxSize: number;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private hits = 0;
  private misses = 0;

  constructor(config: CacheConfig) {
    this.dbName = config.name ?? 'profile-service-cache';
    this.storeName = 'cache';
    this.defaultTtlMs = config.defaultTtlMs;
    this.maxSize = config.maxSize ?? 1000;
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

      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        reject(storageError('Failed to open IndexedDB', request.error ?? undefined));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'key' });
          store.createIndex('cachedAt', 'cachedAt', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Get a database transaction
   */
  private async getStore(
    mode: IDBTransactionMode
  ): Promise<IDBObjectStore> {
    await this.init();
    if (!this.db) {
      throw storageError('Database not initialized');
    }
    const transaction = this.db.transaction(this.storeName, mode);
    return transaction.objectStore(this.storeName);
  }

  async get(key: string): Promise<T | null> {
    try {
      const store = await this.getStore('readonly');

      return new Promise((resolve, reject) => {
        const request = store.get(key);

        request.onerror = () => {
          this.misses++;
          reject(storageError('Failed to get from cache', request.error ?? undefined));
        };

        request.onsuccess = () => {
          const entry = request.result as StoredEntry<T> | undefined;

          if (!entry) {
            this.misses++;
            resolve(null);
            return;
          }

          // Check if expired
          if (this.isExpired(entry)) {
            this.misses++;
            // Delete expired entry asynchronously
            this.delete(key).catch(() => {});
            resolve(null);
            return;
          }

          this.hits++;
          resolve(entry.value);
        };
      });
    } catch {
      this.misses++;
      return null;
    }
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    // Check size and evict if needed (uses separate transactions)
    const currentSize = await this.size();
    if (currentSize >= this.maxSize) {
      await this.evictOldest();
    }

    // Re-acquire store after any eviction so the transaction is fresh
    const store = await this.getStore('readwrite');

    const entry: StoredEntry<T> = {
      key,
      value,
      cachedAt: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
    };

    return new Promise((resolve, reject) => {
      const request = store.put(entry);

      request.onerror = () => {
        reject(storageError('Failed to set cache entry', request.error ?? undefined));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async delete(key: string): Promise<void> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.delete(key);

      request.onerror = () => {
        reject(storageError('Failed to delete cache entry', request.error ?? undefined));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== null;
  }

  async clear(): Promise<void> {
    const store = await this.getStore('readwrite');

    return new Promise((resolve, reject) => {
      const request = store.clear();

      request.onerror = () => {
        reject(storageError('Failed to clear cache', request.error ?? undefined));
      };

      request.onsuccess = () => {
        this.hits = 0;
        this.misses = 0;
        resolve();
      };
    });
  }

  async size(): Promise<number> {
    const store = await this.getStore('readonly');

    return new Promise((resolve, reject) => {
      const request = store.count();

      request.onerror = () => {
        reject(storageError('Failed to get cache size', request.error ?? undefined));
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  }

  async stats(): Promise<CacheStats> {
    const entries = await this.size();
    const total = this.hits + this.misses;
    return {
      entries,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Check if an entry is expired
   */
  private isExpired(entry: StoredEntry<T>): boolean {
    return Date.now() - entry.cachedAt > entry.ttlMs;
  }

  /**
   * Evict the oldest entries (LRU)
   */
  private async evictOldest(count = 10): Promise<void> {
    const store = await this.getStore('readwrite');
    const index = store.index('cachedAt');

    return new Promise((resolve, reject) => {
      const request = index.openCursor();
      let deleted = 0;

      request.onerror = () => {
        reject(storageError('Failed to evict old entries', request.error ?? undefined));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && deleted < count) {
          cursor.delete();
          deleted++;
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
  }

  /**
   * Clean up expired entries
   */
  async cleanup(): Promise<number> {
    const store = await this.getStore('readwrite');
    const now = Date.now();
    let cleaned = 0;

    return new Promise((resolve, reject) => {
      const request = store.openCursor();

      request.onerror = () => {
        reject(storageError('Failed to cleanup cache', request.error ?? undefined));
      };

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const entry = cursor.value as StoredEntry<T>;
          if (now - entry.cachedAt > entry.ttlMs) {
            cursor.delete();
            cleaned++;
          }
          cursor.continue();
        } else {
          resolve(cleaned);
        }
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
 * Create an IndexedDB cache store with common defaults
 */
export function createIndexedDBCache<T = unknown>(
  options: Partial<CacheConfig> = {}
): IndexedDBCacheStore<T> {
  return new IndexedDBCacheStore<T>({
    defaultTtlMs: options.defaultTtlMs ?? 24 * 60 * 60 * 1000, // 24 hours default
    maxSize: options.maxSize ?? 1000,
    name: options.name ?? 'profile-service-cache',
  });
}
