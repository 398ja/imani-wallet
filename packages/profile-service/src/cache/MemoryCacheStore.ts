import type { CacheStore, CacheConfig, CacheStats, CacheEntry } from '../types/cache.js';

/**
 * In-memory cache store with TTL and size limit support
 */
export class MemoryCacheStore<T = unknown> implements CacheStore<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private readonly defaultTtlMs: number;
  private readonly maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(config: CacheConfig) {
    this.defaultTtlMs = config.defaultTtlMs;
    this.maxSize = config.maxSize ?? Infinity;
  }

  async get(key: string): Promise<T | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check if expired
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value;
  }

  async set(key: string, value: T, ttlMs?: number): Promise<void> {
    // Enforce size limit using LRU eviction
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictOldest();
    }

    const entry: CacheEntry<T> = {
      value,
      cachedAt: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
      key,
    };

    this.cache.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  async size(): Promise<number> {
    // Clean up expired entries first
    await this.cleanup();
    return this.cache.size;
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
   * Get entry with metadata (for debugging)
   */
  getEntry(key: string): CacheEntry<T> | undefined {
    return this.cache.get(key);
  }

  /**
   * Check if an entry is expired
   */
  private isExpired(entry: CacheEntry<T>): boolean {
    return Date.now() - entry.cachedAt > entry.ttlMs;
  }

  /**
   * Evict the oldest entry (LRU)
   */
  private evictOldest(): void {
    // Map maintains insertion order, so first key is oldest
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Clean up expired entries
   */
  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.cachedAt > entry.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}

/**
 * Create a memory cache store with common defaults
 */
export function createMemoryCache<T = unknown>(
  options: Partial<CacheConfig> = {}
): MemoryCacheStore<T> {
  return new MemoryCacheStore<T>({
    defaultTtlMs: options.defaultTtlMs ?? 5 * 60 * 1000, // 5 minutes default
    maxSize: options.maxSize ?? 100,
    name: options.name ?? 'profile-cache',
  });
}
