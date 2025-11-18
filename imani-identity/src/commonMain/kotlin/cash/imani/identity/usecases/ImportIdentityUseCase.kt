package cash.imani.identity.usecases

import cash.imani.identity.domain.Identity
import cash.imani.identity.repository.IdentityRepository

/**
 * Use case for importing an identity from a BIP39 mnemonic phrase.
 *
 * Responsibilities:
 * - Validates mnemonic phrase (word count, checksum)
 * - Derives secp256k1 keypair from mnemonic
 * - Stores identity securely
 * - Returns imported identity
 *
 * Business Rules:
 * - Mnemonic must be valid BIP39 (12 or 24 words)
 * - Uses Nostr derivation path: m/44'/1237'/0'/0/0 (NIP-06)
 * - Label must be 1-100 characters
 * - Creates new identity ID (not recovered)
 *
 * Design: Command pattern with validation
 */
class ImportIdentityUseCase(
    private val identityRepository: IdentityRepository,
) {
    /**
     * Executes the use case to import an identity from mnemonic.
     *
     * @param mnemonic BIP39 mnemonic phrase (12 or 24 words)
     * @param label User-friendly label for the imported identity
     * @return Result containing the imported Identity
     */
    suspend operator fun invoke(
        mnemonic: String,
        label: String,
    ): Result<Identity> =
        runCatching {
            // Validate inputs
            require(mnemonic.trim().isNotEmpty()) {
                "Mnemonic phrase cannot be empty"
            }
            require(label.trim().isNotEmpty()) {
                "Identity label cannot be empty"
            }

            // Normalize mnemonic (trim, lowercase, single spaces)
            val normalizedMnemonic =
                mnemonic.trim()
                    .lowercase()
                    .replace("\\s+".toRegex(), " ")

            // Import via repository (validates mnemonic format)
            identityRepository.importFromMnemonic(
                mnemonic = normalizedMnemonic,
                label = label.trim(),
            ).getOrThrow()
        }
}
