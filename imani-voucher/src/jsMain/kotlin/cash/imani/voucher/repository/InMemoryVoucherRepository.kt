package cash.imani.voucher.repository

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus

/**
 * In-memory implementation of VoucherRepository for web platform.
 *
 * Phase 2: Temporary in-memory storage for use case testing
 * Phase 3: Will be replaced with IndexedDB implementation (Task 2.5)
 */
actual fun createVoucherRepository(): VoucherRepository = InMemoryVoucherRepository()

class InMemoryVoucherRepository : VoucherRepository {
    private val vouchers = mutableMapOf<String, StoredVoucher>()

    override suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit> =
        runCatching {
            vouchers[voucher.voucherId] = voucher
        }

    override suspend fun getVoucher(voucherId: String): Result<StoredVoucher?> =
        runCatching {
            vouchers[voucherId]
        }

    override suspend fun getVouchersByIssuer(issuerId: String): Result<List<StoredVoucher>> =
        runCatching {
            vouchers.values.filter { it.issuerId == issuerId }
        }

    override suspend fun getAllVouchers(): Result<List<StoredVoucher>> =
        runCatching {
            vouchers.values.toList()
        }

    override suspend fun updateVoucherStatus(
        voucherId: String,
        status: VoucherStatus,
    ): Result<Unit> =
        runCatching {
            val voucher = vouchers[voucherId] ?: throw VoucherNotFoundException(voucherId)
            vouchers[voucherId] = voucher.copy(status = status)
        }

    override suspend fun deleteVoucher(voucherId: String): Result<Unit> =
        runCatching {
            vouchers.remove(voucherId) ?: throw VoucherNotFoundException(voucherId)
        }

    override suspend fun getVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        runCatching {
            vouchers.values.filter { it.status == status }
        }
}

class VoucherNotFoundException(voucherId: String) : Exception("Voucher not found: $voucherId")
