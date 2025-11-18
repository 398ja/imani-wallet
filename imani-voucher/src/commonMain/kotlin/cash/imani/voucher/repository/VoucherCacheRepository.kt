package cash.imani.voucher.repository

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus

/**
 * Local cache repository for vouchers.
 *
 * Provides fast offline access to vouchers with platform-specific storage:
 * - JS: IndexedDB for browser persistence
 * - JVM: In-memory cache for testing/development
 *
 * This cache is synchronized with Nostr relays via NostrVoucherRepository.
 */
interface VoucherCacheRepository {
    /**
     * Saves a voucher to the local cache.
     *
     * @param voucher The voucher to cache
     * @return Result indicating success or failure
     */
    suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit>

    /**
     * Retrieves a voucher from the cache by ID.
     *
     * @param voucherId The voucher ID
     * @return Result containing the voucher if found, null otherwise
     */
    suspend fun getVoucher(voucherId: String): Result<StoredVoucher?>

    /**
     * Lists all cached vouchers.
     *
     * @return Result containing list of all cached vouchers
     */
    suspend fun listVouchers(): Result<List<StoredVoucher>>

    /**
     * Queries vouchers by status from cache.
     *
     * @param status The voucher status to filter by
     * @return Result containing list of matching vouchers
     */
    suspend fun getVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>>

    /**
     * Queries vouchers by issuer from cache.
     *
     * @param issuerPubkey The issuer's public key
     * @return Result containing list of vouchers issued by this key
     */
    suspend fun getVouchersByIssuer(issuerPubkey: String): Result<List<StoredVoucher>>

    /**
     * Updates a voucher's status in the cache.
     *
     * @param voucherId The voucher ID to update
     * @param status The new status
     * @return Result indicating success or failure
     */
    suspend fun updateVoucherStatus(
        voucherId: String,
        status: VoucherStatus,
    ): Result<Unit>

    /**
     * Deletes a voucher from the cache.
     *
     * @param voucherId The voucher ID to delete
     * @return Result indicating success or failure
     */
    suspend fun deleteVoucher(voucherId: String): Result<Unit>

    /**
     * Clears all vouchers from the cache.
     *
     * @return Result indicating success or failure
     */
    suspend fun clearAll(): Result<Unit>

    /**
     * Gets the last sync timestamp.
     *
     * Used to determine when the cache was last synchronized with Nostr.
     *
     * @return Result containing the last sync timestamp in epoch milliseconds, null if never synced
     */
    suspend fun getLastSyncTime(): Result<Long?>

    /**
     * Updates the last sync timestamp.
     *
     * @param timestamp The sync timestamp in epoch milliseconds
     * @return Result indicating success or failure
     */
    suspend fun setLastSyncTime(timestamp: Long): Result<Unit>
}

/**
 * Factory function for creating platform-specific cache repositories.
 *
 * @return Platform-specific VoucherCacheRepository implementation
 */
expect fun createVoucherCacheRepository(): VoucherCacheRepository
