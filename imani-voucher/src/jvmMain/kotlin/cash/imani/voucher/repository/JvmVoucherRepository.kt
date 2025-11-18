package cash.imani.voucher.repository

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import java.util.concurrent.ConcurrentHashMap

/**
 * JVM in-memory implementation of VoucherRepository.
 *
 * Phase 2: Simple in-memory storage for testing
 * Phase 4+: Replace with proper database (Room, SQLDelight, etc.)
 */
actual fun createVoucherRepository(): VoucherRepository = JvmVoucherRepository()

class JvmVoucherRepository : VoucherRepository {
    private val vouchers = ConcurrentHashMap<String, StoredVoucher>()

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
