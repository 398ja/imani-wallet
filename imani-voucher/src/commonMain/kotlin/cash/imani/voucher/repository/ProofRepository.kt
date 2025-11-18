package cash.imani.voucher.repository

import cash.imani.voucher.domain.Proof

/**
 * Repository for managing Cashu proofs.
 *
 * Proofs are cryptographic tokens that represent value in the Cashu system.
 * This repository handles:
 * - Storing received proofs
 * - Retrieving proofs for a specific mint
 * - Selecting proofs to spend (coin selection algorithm)
 * - Deleting spent proofs
 *
 * Implementation:
 * - Web: IndexedDB for persistent browser storage
 * - JVM: In-memory (for testing in Phase 2)
 * - Android/iOS: Platform-specific databases (Phase 4/5)
 */
interface ProofRepository {
    /**
     * Saves proofs to storage.
     *
     * @param proofs List of proofs to save
     * @param mintUrl URL of the mint that issued these proofs
     * @param unit Unit of account (e.g., "sat" for satoshis)
     * @return Result indicating success or failure
     */
    suspend fun saveProofs(
        proofs: List<Proof>,
        mintUrl: String,
        unit: String = "sat",
    ): Result<Unit>

    /**
     * Retrieves all proofs for a specific mint and unit.
     *
     * @param mintUrl URL of the mint
     * @param unit Unit of account (default: "sat")
     * @return Result containing list of proofs or error
     */
    suspend fun getProofs(
        mintUrl: String,
        unit: String = "sat",
    ): Result<List<Proof>>

    /**
     * Selects proofs to spend for a given amount.
     *
     * Uses a coin selection algorithm to choose which proofs to spend:
     * - Phase 2: Simple FIFO (smallest amounts first)
     * - Phase 3+: Optimize for privacy and efficiency
     *
     * @param amount Amount needed (in base units)
     * @param mintUrl URL of the mint
     * @param unit Unit of account (default: "sat")
     * @return Result containing selected proofs or error (InsufficientBalanceException)
     */
    suspend fun selectProofs(
        amount: Long,
        mintUrl: String,
        unit: String = "sat",
    ): Result<List<Proof>>

    /**
     * Deletes proofs by their secrets.
     *
     * Used after proofs have been spent to remove them from storage.
     *
     * @param secrets List of proof secrets to delete
     * @return Result indicating success or failure
     */
    suspend fun deleteProofs(secrets: List<String>): Result<Unit>

    /**
     * Gets the total balance for a specific mint.
     *
     * @param mintUrl URL of the mint
     * @param unit Unit of account (default: "sat")
     * @return Result containing total balance or error
     */
    suspend fun getBalance(
        mintUrl: String,
        unit: String = "sat",
    ): Result<Long> =
        getProofs(mintUrl, unit).map { proofs ->
            proofs.sumOf { it.amount.toLong() }
        }
}

/**
 * Exception thrown when there are insufficient proofs to cover an amount.
 */
class InsufficientBalanceException(message: String) : Exception(message)

/**
 * Factory function to create platform-specific ProofRepository.
 */
expect fun createProofRepository(): ProofRepository
