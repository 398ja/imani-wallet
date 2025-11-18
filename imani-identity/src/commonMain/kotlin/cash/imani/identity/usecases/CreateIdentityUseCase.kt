package cash.imani.identity.usecases

import cash.imani.identity.domain.Identity
import cash.imani.identity.repository.IdentityRepository

/**
 * Use case for creating a new Nostr identity.
 *
 * Responsibilities:
 * - Validates input (label)
 * - Delegates keypair generation to CryptoAdapter (via repository)
 * - Generates BIP39 mnemonic for backup
 * - Stores identity securely
 * - Returns created identity with mnemonic phrase
 *
 * Business Rules:
 * - Label must be 1-100 characters
 * - Generates 32-byte secp256k1 keypair
 * - Creates 12-word BIP39 mnemonic
 * - Private key encrypted at rest
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
     * @return Result containing CreateIdentityResult with identity and mnemonic
     */
    suspend operator fun invoke(label: String): Result<CreateIdentityResult> =
        runCatching {
            // Validate label (repository will also validate, but fail fast here)
            require(label.trim().isNotEmpty()) {
                "Identity label cannot be empty"
            }

            // Create identity via repository
            val identity = identityRepository.createIdentity(label.trim()).getOrThrow()

            // Retrieve mnemonic for display to user
            val mnemonic = identityRepository.exportMnemonic(identity.id).getOrThrow()

            CreateIdentityResult(
                identity = identity,
                mnemonic = mnemonic,
            )
        }
}

/**
 * Result of creating a new identity.
 *
 * @property identity The created identity with metadata
 * @property mnemonic The BIP39 mnemonic phrase (12 words) for backup
 */
data class CreateIdentityResult(
    val identity: Identity,
    val mnemonic: String,
)
