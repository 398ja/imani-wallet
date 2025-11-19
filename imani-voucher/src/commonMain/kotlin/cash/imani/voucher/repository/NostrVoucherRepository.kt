package cash.imani.voucher.repository

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.nostr.NostrConfig
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.nostr.createNostrVoucherClient
import kotlinx.coroutines.*
import kotlinx.datetime.Clock

/**
 * Hybrid voucher repository using Nostr relays with local cache.
 *
 * Architecture:
 * - **Nostr**: Source of truth for voucher storage (decentralized, multi-device sync)
 * - **Cache**: Fast offline access (IndexedDB on JS, in-memory on JVM)
 *
 * Write Pattern (Publish-First):
 * 1. Publish voucher to Nostr relays
 * 2. Cache locally on success
 * 3. Return result to caller
 *
 * Read Pattern (Cache-First):
 * 1. Check local cache first (fast)
 * 2. Return cached result if available
 * 3. Optionally sync from Nostr in background
 *
 * Sync Strategy:
 * - Manual sync via syncFromNostr()
 * - Background sync on startup (if last sync > threshold)
 * - Phase 3: Automatic periodic sync with WebSocket subscriptions
 *
 * Error Handling:
 * - Cache failures: Log warning, continue with Nostr
 * - Nostr failures: Return error to caller (source of truth unavailable)
 * - Partial relay failures: Succeed if any relay accepts (Nostr handles multi-relay)
 *
 * @param nostrClient Client for Nostr relay operations
 * @param cache Local cache for offline access
 * @param syncOnInit Whether to sync from Nostr on initialization
 * @param syncThresholdMs Minimum time between syncs (default: 5 minutes)
 */
class NostrVoucherRepository(
    private val nostrClient: NostrVoucherClient,
    private val cache: VoucherCacheRepository,
    private val syncOnInit: Boolean = true,
    // 5 minutes
    private val syncThresholdMs: Long = 5 * 60 * 1000,
) : VoucherRepository {
    private val syncScope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private var isSyncing = false

    init {
        if (syncOnInit) {
            syncScope.launch {
                syncIfNeeded()
            }
        }
    }

    override suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit> =
        runCatching {
            // 1. Publish to Nostr first (source of truth)
            nostrClient.publishVoucher(voucher).getOrThrow()

            // 2. Cache locally on success
            cache.saveVoucher(voucher).onFailure { error ->
                // Log cache failure but don't fail the operation
                println(
                    "[NostrVoucherRepository] Warning: Failed to cache voucher ${voucher.voucherId}: ${error.message}",
                )
            }

            println("[NostrVoucherRepository] Saved voucher ${voucher.voucherId} to Nostr and cache")
        }

    override suspend fun getVoucher(voucherId: String): Result<StoredVoucher?> =
        runCatching {
            // Cache-first read for fast response
            val cached = cache.getVoucher(voucherId).getOrNull()

            if (cached != null) {
                println("[NostrVoucherRepository] Cache hit for voucher $voucherId")
                cached
            } else {
                // Cache miss: query from Nostr
                println("[NostrVoucherRepository] Cache miss for voucher $voucherId, querying Nostr")
                val fromNostr = nostrClient.queryVoucher(voucherId).getOrThrow()

                // Cache the result for next time
                fromNostr?.let { voucher ->
                    cache.saveVoucher(voucher).onFailure { error ->
                        println("[NostrVoucherRepository] Warning: Failed to cache voucher: ${error.message}")
                    }
                }

                fromNostr
            }
        }

    override suspend fun getVouchersByIssuer(issuerId: String): Result<List<StoredVoucher>> =
        runCatching {
            // Try cache first
            val cached = cache.getVouchersByIssuer(issuerId).getOrNull()

            if (!cached.isNullOrEmpty()) {
                println("[NostrVoucherRepository] Cache hit for issuer $issuerId: ${cached.size} vouchers")
                cached
            } else {
                // Cache miss or empty: query from Nostr
                println("[NostrVoucherRepository] Querying Nostr for issuer $issuerId")
                val fromNostr = nostrClient.queryVouchersByIssuer(issuerId).getOrThrow()

                // Cache the results
                fromNostr.forEach { voucher ->
                    cache.saveVoucher(voucher).onFailure { error ->
                        println("[NostrVoucherRepository] Warning: Failed to cache voucher: ${error.message}")
                    }
                }

                fromNostr
            }
        }

    override suspend fun getAllVouchers(): Result<List<StoredVoucher>> =
        runCatching {
            // Return cached vouchers (fast)
            val cached = cache.listVouchers().getOrThrow()
            println("[NostrVoucherRepository] Retrieved ${cached.size} vouchers from cache")
            cached
        }

    override suspend fun updateVoucherStatus(
        voucherId: String,
        status: VoucherStatus,
    ): Result<Unit> =
        runCatching {
            // 1. Update on Nostr (publishes replacement event via NIP-33)
            nostrClient.updateVoucherStatus(voucherId, status).getOrThrow()

            // 2. Update cache
            cache.updateVoucherStatus(voucherId, status).onFailure { error ->
                println("[NostrVoucherRepository] Warning: Failed to update cache: ${error.message}")
            }

            println("[NostrVoucherRepository] Updated voucher $voucherId status to $status")
        }

    override suspend fun deleteVoucher(voucherId: String): Result<Unit> =
        runCatching {
            // Note: Nostr events cannot be truly deleted (relays may retain)
            // We only delete from local cache
            // Phase 3: Could publish a deletion marker event

            cache.deleteVoucher(voucherId).getOrThrow()
            println("[NostrVoucherRepository] Deleted voucher $voucherId from cache (Nostr events remain)")
        }

    override suspend fun getVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        runCatching {
            // Try cache first
            val cached = cache.getVouchersByStatus(status).getOrNull()

            if (!cached.isNullOrEmpty()) {
                println("[NostrVoucherRepository] Cache hit for status $status: ${cached.size} vouchers")
                cached
            } else {
                // Cache miss or empty: query from Nostr
                println("[NostrVoucherRepository] Querying Nostr for status $status")
                val fromNostr = nostrClient.queryVouchersByStatus(status).getOrThrow()

                // Cache the results
                fromNostr.forEach { voucher ->
                    cache.saveVoucher(voucher).onFailure { error ->
                        println("[NostrVoucherRepository] Warning: Failed to cache voucher: ${error.message}")
                    }
                }

                fromNostr
            }
        }

    /**
     * Synchronizes vouchers from Nostr to local cache.
     *
     * Fetches all vouchers from Nostr relays and updates the local cache.
     * This is useful for:
     * - Initial sync on new device
     * - Periodic sync to catch updates from other devices
     * - Manual refresh requested by user
     *
     * Phase 3 Enhancement:
     * - Use last sync timestamp to only fetch new/updated events
     * - Implement incremental sync instead of full sync
     * - Add WebSocket subscriptions for real-time updates
     *
     * @return Result containing number of vouchers synced
     */
    suspend fun syncFromNostr(): Result<Int> =
        runCatching {
            if (isSyncing) {
                println("[NostrVoucherRepository] Sync already in progress, skipping")
                return Result.success(0)
            }

            isSyncing = true
            try {
                println("[NostrVoucherRepository] Starting full sync from Nostr")

                // Phase 2: Simple approach - query all statuses
                // Phase 3: Use timestamp-based incremental sync
                val allVouchers = mutableListOf<StoredVoucher>()

                VoucherStatus.entries.forEach { status ->
                    val vouchers = nostrClient.queryVouchersByStatus(status).getOrNull() ?: emptyList()
                    allVouchers.addAll(vouchers)
                }

                // Update cache with fetched vouchers
                allVouchers.forEach { voucher ->
                    cache.saveVoucher(voucher).onFailure { error ->
                        println(
                            "[NostrVoucherRepository] Warning: Failed to cache voucher during sync: ${error.message}",
                        )
                    }
                }

                // Update last sync timestamp
                val now = Clock.System.now().toEpochMilliseconds()
                cache.setLastSyncTime(now).getOrNull()

                println("[NostrVoucherRepository] Synced ${allVouchers.size} vouchers from Nostr")
                allVouchers.size
            } finally {
                isSyncing = false
            }
        }

    /**
     * Synchronizes from Nostr only if last sync exceeds threshold.
     *
     * @return Result containing number of vouchers synced (0 if skipped)
     */
    suspend fun syncIfNeeded(): Result<Int> =
        runCatching {
            val lastSync = cache.getLastSyncTime().getOrNull()
            val now = Clock.System.now().toEpochMilliseconds()

            if (lastSync == null || (now - lastSync) > syncThresholdMs) {
                println("[NostrVoucherRepository] Last sync: ${lastSync ?: "never"}, syncing now")
                syncFromNostr().getOrThrow()
            } else {
                println("[NostrVoucherRepository] Last sync recent (${now - lastSync}ms ago), skipping")
                0
            }
        }

    /**
     * Clears local cache.
     *
     * Does not affect Nostr storage (source of truth remains intact).
     * Use this to force a fresh sync or clear sensitive data.
     *
     * @return Result indicating success or failure
     */
    suspend fun clearCache(): Result<Unit> = cache.clearAll()

    /**
     * Gets cache statistics.
     *
     * @return Map with cache info (last sync time, voucher count, etc.)
     */
    suspend fun getCacheStats(): Result<Map<String, Any>> =
        runCatching {
            val lastSync: Any? = cache.getLastSyncTime().getOrNull()
            val voucherCount = cache.listVouchers().getOrNull()?.size ?: 0

            mapOf(
                "lastSyncTime" to (lastSync ?: "never"),
                "voucherCount" to voucherCount,
                "syncThresholdMs" to syncThresholdMs,
                "isSyncing" to isSyncing,
            )
        }

    /**
     * Closes resources and cancels background sync.
     *
     * Should be called when repository is no longer needed.
     */
    fun close() {
        syncScope.cancel()
        println("[NostrVoucherRepository] Closed repository and canceled sync scope")
    }
}

/**
 * Factory function for creating NostrVoucherRepository with default configuration.
 *
 * Uses default Nostr relays and platform-specific cache implementation.
 *
 * @param relayUrls List of Nostr relay URLs (defaults to NostrConfig.DEFAULT_RELAYS)
 * @param syncOnInit Whether to sync from Nostr on initialization (default: true)
 * @return Configured NostrVoucherRepository instance
 */
fun createNostrVoucherRepository(
    relayUrls: List<String> = NostrConfig.DEFAULT_RELAYS,
    syncOnInit: Boolean = true,
): NostrVoucherRepository {
    val nostrClient = createNostrVoucherClient(relayUrls)
    val cache = createVoucherCacheRepository()

    return NostrVoucherRepository(
        nostrClient = nostrClient,
        cache = cache,
        syncOnInit = syncOnInit,
    )
}
