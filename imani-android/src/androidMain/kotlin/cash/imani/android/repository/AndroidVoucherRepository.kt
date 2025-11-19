package cash.imani.android.repository

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOneOrNull
import cash.imani.android.db.ImaniDatabase
import cash.imani.voucher.domain.Proof
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.repository.VoucherRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant

/**
 * Android implementation of VoucherRepository using SQLDelight.
 *
 * This is a thin wrapper that:
 * 1. Uses imani-voucher domain models (StoredVoucher, Proof)
 * 2. Persists vouchers and proofs in SQLDelight database
 * 3. Provides reactive Flow-based queries for UI
 *
 * Code Reuse:
 * - Domain models: cash.imani.voucher.domain.* (100% reused)
 * - Persistence: SQLDelight generated queries
 */
class AndroidVoucherRepository(
    private val database: ImaniDatabase,
) : VoucherRepository {
    private val voucherQueries = database.voucherQueries

    // ==================== Voucher Operations ====================

    override suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.insertVoucher(
                    voucherId = voucher.voucherId,
                    issuerId = voucher.issuerId,
                    unit = voucher.unit,
                    faceValue = voucher.faceValue,
                    expiresAt = voucher.expiresAt,
                    memo = voucher.memo,
                    issuerSignature = voucher.issuerSignature,
                    issuerPublicKey = voucher.issuerPublicKey,
                    issuedAt = voucher.issuedAt.toEpochMilliseconds(),
                    status = voucher.status.name,
                    token = voucher.token,
                    syncStatus = "synced",
                    lastSyncAt = Clock.System.now().toEpochMilliseconds(),
                )
            }
        }

    override suspend fun getAllVouchers(): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.selectAllVouchers()
                    .executeAsList()
                    .map { it.toStoredVoucher() }
            }
        }

    override suspend fun getVoucher(voucherId: String): Result<StoredVoucher?> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.selectVoucherById(voucherId).executeAsOneOrNull()?.toStoredVoucher()
            }
        }

    override suspend fun updateVoucherStatus(
        id: String,
        status: VoucherStatus,
    ): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.updateVoucherStatus(status = status.name, voucherId = id)
            }
        }

    override suspend fun deleteVoucher(id: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                // Delete associated proofs first (foreign key constraint)
                voucherQueries.deleteProofsByVoucher(id)
                // Then delete voucher
                voucherQueries.deleteVoucher(id)
            }
        }

    /**
     * Get vouchers by status.
     */
    override suspend fun getVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.selectVouchersByStatus(status.name)
                    .executeAsList()
                    .map { it.toStoredVoucher() }
            }
        }

    /**
     * Get vouchers by issuer.
     */
    override suspend fun getVouchersByIssuer(issuerId: String): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.selectVouchersByIssuer(issuerId)
                    .executeAsList()
                    .map { it.toStoredVoucher() }
            }
        }

    /**
     * Get expired vouchers.
     */
    suspend fun getExpiredVouchers(): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val now = Clock.System.now().epochSeconds
                // SQLDelight query might return a projection type, so we fetch by filtering after retrieval
                voucherQueries.selectAllVouchers()
                    .executeAsList()
                    .filter { it.expiresAt != null && it.expiresAt < now }
                    .map { it.toStoredVoucher() }
            }
        }

    /**
     * Get vouchers pending sync to Nostr relays.
     */
    suspend fun getPendingSyncVouchers(): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.selectPendingSyncVouchers()
                    .executeAsList()
                    .map { it.toStoredVoucher() }
            }
        }

    /**
     * Update voucher sync status.
     */
    suspend fun updateSyncStatus(
        id: String,
        syncStatus: String,
    ): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val now = Clock.System.now().toEpochMilliseconds()
                voucherQueries.updateVoucherSyncStatus(
                    syncStatus = syncStatus,
                    lastSyncAt = now,
                    voucherId = id,
                )
            }
        }

    // ==================== Proof Operations ====================

    /**
     * Save proofs to database.
     */
    suspend fun saveProofs(
        proofs: List<Proof>,
        voucherId: String? = null,
    ): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                proofs.forEach { proof ->
                    voucherQueries.insertProof(
                        voucherId = voucherId,
                        amount = proof.amount.toLong(),
                        secret = proof.secret,
                        C = proof.C,
                        keysetId = proof.id,
                        mintUrl = "", // TODO: Get from voucher or proof metadata
                        unit = "sat", // TODO: Get from voucher or proof metadata
                        createdAt = Clock.System.now().toEpochMilliseconds(),
                        spentAt = null,
                    )
                }
            }
        }

    /**
     * Get all unspent proofs.
     */
    suspend fun getUnspentProofs(): Result<List<Proof>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.selectAllProofs()
                    .executeAsList()
                    .map { it.toProof() }
            }
        }

    /**
     * Get proofs by voucher ID.
     */
    suspend fun getProofsByVoucher(voucherId: String): Result<List<Proof>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.selectProofsByVoucher(voucherId)
                    .executeAsList()
                    .map { it.toProof() }
            }
        }

    /**
     * Get proofs by mint URL and unit.
     */
    suspend fun getProofsByMint(
        mintUrl: String,
        unit: String,
    ): Result<List<Proof>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherQueries.selectProofsByMint(mintUrl = mintUrl, unit = unit)
                    .executeAsList()
                    .map { it.toProof() }
            }
        }

    /**
     * Select proofs for a specific amount (FIFO selection).
     */
    suspend fun selectProofsForAmount(
        amount: Long,
        mintUrl: String,
        unit: String,
    ): Result<List<Proof>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val allProofs =
                    voucherQueries.selectProofsForAmount(mintUrl = mintUrl, unit = unit)
                        .executeAsList()
                        .map { it.toProof() }

                // FIFO selection: sort by amount ascending, select until we meet the target
                var remaining = amount
                val selected = mutableListOf<Proof>()

                for (proof in allProofs.sortedBy { it.amount }) {
                    if (remaining <= 0) break
                    selected.add(proof)
                    remaining -= proof.amount
                }

                if (remaining > 0) {
                    throw InsufficientBalanceException(
                        "Insufficient balance. Need $remaining more, have ${allProofs.sumOf { it.amount }}",
                    )
                }

                selected
            }
        }

    /**
     * Mark proof as spent.
     */
    suspend fun markProofAsSpent(secret: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val now = Clock.System.now().toEpochMilliseconds()
                voucherQueries.markProofAsSpent(spentAt = now, secret = secret)
            }
        }

    /**
     * Delete proofs by secrets.
     */
    suspend fun deleteProofs(secrets: List<String>): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                secrets.forEach { secret ->
                    val proof = voucherQueries.selectProofBySecret(secret).executeAsOneOrNull()
                    proof?.let {
                        voucherQueries.deleteProof(it.id)
                    }
                }
            }
        }

    /**
     * Get total unspent balance by mint and unit.
     */
    suspend fun getUnspentBalance(
        mintUrl: String,
        unit: String,
    ): Result<Long> =
        withContext(Dispatchers.IO) {
            runCatching {
                // Manually calculate sum - fetch all proofs and filter/sum
                val proofs = voucherQueries.selectAllProofs().executeAsList()
                proofs
                    .filter { proof -> proof.mintUrl == mintUrl && proof.unit == unit }
                    .sumOf { proof -> proof.amount.toLong() }
            }
        }

    // ==================== Reactive Queries (Flow) ====================

    /**
     * Observe all vouchers as a Flow (for reactive UI).
     */
    fun observeVouchers(): Flow<List<StoredVoucher>> {
        return voucherQueries.selectAllVouchers()
            .asFlow()
            .mapToList(Dispatchers.IO)
            .map { entities -> entities.map { it.toStoredVoucher() } }
    }

    /**
     * Observe vouchers by status as a Flow.
     */
    fun observeVouchersByStatus(status: VoucherStatus): Flow<List<StoredVoucher>> {
        return voucherQueries.selectVouchersByStatus(status.name)
            .asFlow()
            .mapToList(Dispatchers.IO)
            .map { entities -> entities.map { it.toStoredVoucher() } }
    }

    /**
     * Observe a single voucher by ID as a Flow.
     */
    fun observeVoucher(id: String): Flow<StoredVoucher?> {
        return voucherQueries.selectVoucherById(id)
            .asFlow()
            .mapToOneOrNull(Dispatchers.IO)
            .map { it?.toStoredVoucher() }
    }

    /**
     * Observe unspent proofs as a Flow.
     */
    fun observeUnspentProofs(): Flow<List<Proof>> {
        return voucherQueries.selectAllProofs()
            .asFlow()
            .mapToList(Dispatchers.IO)
            .map { entities -> entities.map { it.toProof() } }
    }

    // ==================== Mapping Extensions ====================

    private fun cash.imani.android.db.VoucherEntity.toStoredVoucher(): StoredVoucher {
        return StoredVoucher(
            voucherId = voucherId,
            issuerId = issuerId,
            unit = unit,
            faceValue = faceValue,
            expiresAt = expiresAt,
            memo = memo,
            issuerSignature = issuerSignature,
            issuerPublicKey = issuerPublicKey,
            issuedAt = Instant.fromEpochMilliseconds(issuedAt),
            status = VoucherStatus.valueOf(status),
            token = token,
        )
    }

    private fun cash.imani.android.db.ProofEntity.toProof(): Proof {
        return Proof(
            amount = amount.toInt(),
            secret = secret,
            C = C,
            id = keysetId,
        )
    }
}

/**
 * Thrown when a voucher is not found in the repository.
 */
class VoucherNotFoundException(id: String) : Exception("Voucher not found: $id")

/**
 * Thrown when there are insufficient proofs to cover the requested amount.
 */
class InsufficientBalanceException(message: String) : Exception(message)
