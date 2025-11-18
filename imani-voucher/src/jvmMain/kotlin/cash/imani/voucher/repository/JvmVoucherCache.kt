package cash.imani.voucher.repository

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * JVM implementation of VoucherCacheRepository using in-memory storage.
 *
 * Uses thread-safe ConcurrentHashMap for voucher storage with no persistence.
 * Suitable for testing, development, and scenarios where persistence isn't required.
 *
 * Thread Safety:
 * - All operations are thread-safe via ConcurrentHashMap
 * - Atomic operations for last sync timestamp
 *
 * Phase 3 Enhancement:
 * - Could add optional persistence using SQLite or H2 database
 * - Could integrate with cashu-client's existing storage layer
 *
 * Memory Characteristics:
 * - Vouchers held in memory until JVM shutdown or clearAll()
 * - No automatic eviction policy (all vouchers retained)
 * - Consider implementing LRU cache for production use
 */
class JvmVoucherCache : VoucherCacheRepository {
    private val vouchers = ConcurrentHashMap<String, StoredVoucher>()
    private val lastSyncTime = AtomicLong(0L)

    override suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                vouchers[voucher.voucherId] = voucher
                println("[JvmVoucherCache] Saved voucher ${voucher.voucherId}")
            }
        }

    override suspend fun getVoucher(voucherId: String): Result<StoredVoucher?> =
        withContext(Dispatchers.IO) {
            runCatching {
                val voucher = vouchers[voucherId]
                if (voucher != null) {
                    println("[JvmVoucherCache] Retrieved voucher $voucherId")
                } else {
                    println("[JvmVoucherCache] Voucher not found: $voucherId")
                }
                voucher
            }
        }

    override suspend fun listVouchers(): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val allVouchers = vouchers.values.toList()
                println("[JvmVoucherCache] Listed ${allVouchers.size} vouchers")
                allVouchers
            }
        }

    override suspend fun getVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val filtered = vouchers.values.filter { it.status == status }
                println("[JvmVoucherCache] Found ${filtered.size} vouchers with status $status")
                filtered
            }
        }

    override suspend fun getVouchersByIssuer(issuerPubkey: String): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val filtered = vouchers.values.filter { it.issuerPublicKey == issuerPubkey }
                println("[JvmVoucherCache] Found ${filtered.size} vouchers from issuer $issuerPubkey")
                filtered
            }
        }

    override suspend fun updateVoucherStatus(
        voucherId: String,
        status: VoucherStatus,
    ): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val voucher =
                    vouchers[voucherId]
                        ?: throw IllegalArgumentException("Voucher not found: $voucherId")

                val updatedVoucher = voucher.copy(status = status)
                vouchers[voucherId] = updatedVoucher

                println("[JvmVoucherCache] Updated voucher $voucherId status to $status")
            }
        }

    override suspend fun deleteVoucher(voucherId: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                vouchers.remove(voucherId)
                println("[JvmVoucherCache] Deleted voucher $voucherId")
            }
        }

    override suspend fun clearAll(): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val count = vouchers.size
                vouchers.clear()
                println("[JvmVoucherCache] Cleared $count vouchers from cache")
            }
        }

    override suspend fun getLastSyncTime(): Result<Long?> =
        withContext(Dispatchers.IO) {
            runCatching {
                val timestamp = lastSyncTime.get()
                val result = if (timestamp == 0L) null else timestamp
                println("[JvmVoucherCache] Last sync time: $result")
                result
            }
        }

    override suspend fun setLastSyncTime(timestamp: Long): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                lastSyncTime.set(timestamp)
                println("[JvmVoucherCache] Set last sync time to $timestamp")
            }
        }

    /**
     * Gets current cache statistics.
     *
     * @return Map with cache metrics (size, memory estimate, etc.)
     */
    fun getStats(): Map<String, Any> {
        val lastSync: Any = lastSyncTime.get().takeIf { it != 0L } ?: "never"
        return mapOf(
            "size" to vouchers.size,
            "lastSyncTime" to lastSync,
            "estimatedMemoryKB" to (vouchers.size * 2), // Rough estimate: ~2KB per voucher
        )
    }

    /**
     * Checks if a voucher exists in cache.
     *
     * @param voucherId The voucher ID
     * @return true if voucher exists in cache
     */
    fun contains(voucherId: String): Boolean {
        return vouchers.containsKey(voucherId)
    }
}

/**
 * Factory function for creating JVM cache.
 */
actual fun createVoucherCacheRepository(): VoucherCacheRepository {
    return JvmVoucherCache()
}
