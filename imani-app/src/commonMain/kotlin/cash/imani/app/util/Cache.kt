package cash.imani.app.util

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes

/**
 * In-memory cache with TTL support for performance optimization.
 *
 * Used for:
 * - Nostr query caching (15 min default)
 * - Merchant profile caching
 * - Offer list caching
 *
 * Phase 5.3: Performance Optimization
 * See: project/web-marketplace-ui-implementation.md Phase 5, Task 5.3
 *
 * @param defaultTtl Default time-to-live for cached entries
 */
class MemoryCache<K, V>(
    private val defaultTtl: Duration = 15.minutes,
) {
    private val cache = mutableMapOf<K, CacheEntry<V>>()
    private val mutex = Mutex()

    private data class CacheEntry<V>(
        val value: V,
        val expiresAt: Instant,
    )

    /**
     * Gets a cached value, or null if not present or expired.
     */
    suspend fun get(key: K): V? = mutex.withLock {
        val entry = cache[key] ?: return@withLock null
        if (Clock.System.now() > entry.expiresAt) {
            cache.remove(key)
            return@withLock null
        }
        entry.value
    }

    /**
     * Puts a value in the cache with optional custom TTL.
     */
    suspend fun put(key: K, value: V, ttl: Duration = defaultTtl) = mutex.withLock {
        cache[key] = CacheEntry(
            value = value,
            expiresAt = Clock.System.now() + ttl,
        )
    }

    /**
     * Gets a cached value or computes it if not present.
     */
    suspend fun getOrPut(key: K, ttl: Duration = defaultTtl, compute: suspend () -> V): V {
        get(key)?.let { return it }
        val value = compute()
        put(key, value, ttl)
        return value
    }

    /**
     * Removes a value from the cache.
     */
    suspend fun remove(key: K): Unit = mutex.withLock {
        cache.remove(key)
        Unit
    }

    /**
     * Clears all cached values.
     */
    suspend fun clear(): Unit = mutex.withLock {
        cache.clear()
    }

    /**
     * Returns the number of cached entries.
     */
    suspend fun size(): Int = mutex.withLock {
        cache.size
    }

    /**
     * Removes expired entries from the cache.
     */
    suspend fun evictExpired(): Unit = mutex.withLock {
        val now = Clock.System.now()
        val expiredKeys = cache.entries.filter { it.value.expiresAt < now }.map { it.key }
        expiredKeys.forEach { cache.remove(it) }
    }
}

/**
 * Cache keys for common data types.
 */
object CacheKeys {
    fun merchantProfile(npub: String) = "merchant:$npub"
    fun merchantOffers(npub: String) = "offers:$npub"
    fun voucherDetails(id: String) = "voucher:$id"
    fun nostrQuery(filter: String) = "nostr:$filter"
}

/**
 * Application-wide caches.
 */
object AppCaches {
    /**
     * Cache for merchant profiles (15 min TTL).
     */
    val merchantProfiles = MemoryCache<String, Any>(defaultTtl = 15.minutes)

    /**
     * Cache for merchant offers (5 min TTL - more volatile).
     */
    val merchantOffers = MemoryCache<String, Any>(defaultTtl = 5.minutes)

    /**
     * Cache for Nostr query results (15 min TTL).
     */
    val nostrQueries = MemoryCache<String, Any>(defaultTtl = 15.minutes)

    /**
     * Clears all application caches.
     */
    suspend fun clearAll() {
        merchantProfiles.clear()
        merchantOffers.clear()
        nostrQueries.clear()
    }
}
