package cash.imani.identity.usecases

import cash.imani.identity.domain.Identity
import cash.imani.identity.repository.IdentityRepository

/**
 * Use case for creating a new Nostr identity.
 *
 * Responsibilities:
 * - Validates input (label)
 * - Delegates keypair generation to CryptoAdapter (via repository)
 * - Stores identity securely
 * - Returns created identity (nsec/npub)
 *
 * Business Rules:
 * - Label must be 1-100 characters
 * - Generates 32-byte secp256k1 keypair
 * - Private key encrypted at rest
 *
 * Note (Phase 1): BIP39 mnemonic generation deferred to Phase 2 (wallet functionality).
 * Nostr identities only require secp256k1 keys (nsec/npub), not mnemonics.
 *
 * Design: Command pattern with single responsibility
 */
class CreateIdentityUseCase(
    private val identityRepository: IdentityRepository,
) {
    /**
     * Executes the use case to create a new identity.
     *
     * @param label User-friendly label for the identity
     * @return Result containing the created Identity
     */
    suspend operator fun invoke(label: String): Result<Identity> =
        runCatching {
            // Validate label (repository will also validate, but fail fast here)
            require(label.trim().isNotEmpty()) {
                "Identity label cannot be empty"
            }

            // Create identity via repository
            identityRepository.createIdentity(label.trim()).getOrThrow()
        }
}
