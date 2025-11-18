package cash.imani.voucher.repository

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus

/**
 * Repository interface for voucher persistence operations.
 *
 * Phase 2: Simple interface for use cases
 * Phase 3+: Full implementation with IndexedDB/SQLDelight
 *
 * Storage strategy:
 * - IndexedDB for web platform (persistent browser storage)
 * - SQLDelight for JVM/Android/iOS platforms
 * - In-memory for testing
 */
interface VoucherRepository {
    /**
     * Save a voucher to storage.
     *
     * @param voucher The voucher to save
     * @return Result indicating success or failure
     */
    suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit>

    /**
     * Retrieve a voucher by ID.
     *
     * @param voucherId The unique voucher identifier
     * @return Result containing the voucher or failure
     */
    suspend fun getVoucher(voucherId: String): Result<StoredVoucher?>

    /**
     * Get all vouchers for a specific issuer identity.
     *
     * @param issuerId The identity ID of the issuer
     * @return Result containing list of vouchers
     */
    suspend fun getVouchersByIssuer(issuerId: String): Result<List<StoredVoucher>>

    /**
     * Get all vouchers (issued + received).
     *
     * @return Result containing all vouchers
     */
    suspend fun getAllVouchers(): Result<List<StoredVoucher>>

    /**
     * Update voucher status.
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
     * Delete a voucher from storage.
     *
     * @param voucherId The voucher ID to delete
     * @return Result indicating success or failure
     */
    suspend fun deleteVoucher(voucherId: String): Result<Unit>

    /**
     * Get vouchers filtered by status.
     *
     * @param status The status to filter by
     * @return Result containing filtered vouchers
     */
    suspend fun getVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>>
}

/**
 * Factory function for creating platform-specific VoucherRepository.
 * Implementation provided via expect/actual pattern.
 */
expect fun createVoucherRepository(): VoucherRepository
