package cash.imani.voucher.repository

import cash.imani.voucher.domain.Proof
import java.util.concurrent.ConcurrentHashMap

/**
 * JVM in-memory implementation of ProofRepository.
 *
 * Phase 2: Simple in-memory storage for testing
 * Phase 4+: Replace with proper database (Room, SQLDelight, etc.)
 */
actual fun createProofRepository(): ProofRepository = JvmProofRepository()

class JvmProofRepository : ProofRepository {
    // Key: "mintUrl:unit", Value: List of proofs
    private val proofs = ConcurrentHashMap<String, MutableList<Proof>>()

    private fun getKey(
        mintUrl: String,
        unit: String,
    ): String = "$mintUrl:$unit"

    override suspend fun saveProofs(
        proofs: List<Proof>,
        mintUrl: String,
        unit: String,
    ): Result<Unit> =
        runCatching {
            val key = getKey(mintUrl, unit)
            this.proofs.getOrPut(key) { mutableListOf() }.addAll(proofs)
        }

    override suspend fun getProofs(
        mintUrl: String,
        unit: String,
    ): Result<List<Proof>> =
        runCatching {
            val key = getKey(mintUrl, unit)
            proofs[key]?.toList() ?: emptyList()
        }

    override suspend fun selectProofs(
        amount: Long,
        mintUrl: String,
        unit: String,
    ): Result<List<Proof>> =
        runCatching {
            val allProofs = getProofs(mintUrl, unit).getOrThrow()

            // Simple FIFO selection: prefer smaller denominations first
            var remaining = amount
            val selected = mutableListOf<Proof>()

            for (proof in allProofs.sortedBy { it.amount }) {
                if (remaining <= 0) break
                selected.add(proof)
                remaining -= proof.amount
            }

            if (remaining > 0) {
                throw InsufficientBalanceException(
                    "Insufficient balance: need $remaining more sats (have ${amount - remaining}, need $amount)",
                )
            }

            selected
        }

    override suspend fun deleteProofs(secrets: List<String>): Result<Unit> =
        runCatching {
            val secretSet = secrets.toSet()
            proofs.values.forEach { list ->
                list.removeAll { it.secret in secretSet }
            }
        }
}
