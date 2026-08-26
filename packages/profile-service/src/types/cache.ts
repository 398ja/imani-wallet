/**
 * Cache entry with metadata
 */
export interface CacheEntry<T> {
  /** The cached value */
  value: T;
  /** When the entry was cached */
  cachedAt: number;
  /** Time-to-live in milliseconds */
  ttlMs: number;
  /** Optional key for this entry */
  key?: string;
}

/**
 * Cache store configuration
 */
export interface CacheConfig {
  /** Default TTL in milliseconds */
  defaultTtlMs: number;
  /** Maximum number of entries */
  maxSize?: number;
  /** Cache name/prefix for storage */
  name?: string;
}

/**
 * Generic cache store interface
 */
export interface CacheStore<T = unknown> {
  /**
   * Get a value from cache
   * @param key - Cache key
   * @returns Cached value or null if not found/expired
   */
  get(key: string): Promise<T | null>;

  /**
   * Set a value in cache
   * @param key - Cache key
   * @param value - Value to cache
   * @param ttlMs - Optional TTL override
   */
  set(key: string, value: T, ttlMs?: number): Promise<void>;

  /**
   * Delete a value from cache
   * @param key - Cache key
   */
  delete(key: string): Promise<void>;

  /**
   * Check if key exists and is not expired
   * @param key - Cache key
   */
  has(key: string): Promise<boolean>;

  /**
   * Clear all entries from cache
   */
  clear(): Promise<void>;

  /**
   * Get the number of entries in cache
   */
  size(): Promise<number>;

  /**
   * Get cache statistics
   */
  stats?(): Promise<CacheStats>;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Total number of entries */
  entries: number;
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Hit rate (0-1) */
  hitRate: number;
  /** Approximate size in bytes (if available) */
  sizeBytes?: number;
}
