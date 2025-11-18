package cash.imani.identity.usecases

import cash.imani.identity.domain.Identity
import cash.imani.identity.repository.IdentityRepository

/**
 * Use case for importing an identity from an nsec (Nostr private key).
 *
 * Responsibilities:
 * - Validates nsec format (bech32 with "nsec1" prefix)
 * - Decodes nsec to extract private key
 * - Derives public key from private key using secp256k1
 * - Stores identity securely
 * - Returns imported identity
 *
 * Business Rules:
 * - nsec must be valid Bech32 format with "nsec1" prefix
 * - Private key must be 32 bytes (after decoding)
 * - Label must be 1-100 characters
 * - No mnemonic is generated (nsec serves as backup)
 * - Public key (npub) is derived from private key
 *
 * Design: Command pattern with validation
 *
 * Note: nsec imports are different from mnemonic imports:
 * - Mnemonic imports use BIP39/BIP32 derivation
 * - nsec imports use direct private key import
 * - nsec imports don't have a recoverable mnemonic
 */
class ImportIdentityFromNsecUseCase(
    private val identityRepository: IdentityRepository,
) {
    /**
     * Executes the use case to import an identity from nsec.
     *
     * @param nsec Bech32-encoded private key (nsec1...)
     * @param label User-friendly label for the imported identity
     * @return Result containing the imported Identity
     */
    suspend operator fun invoke(
        nsec: String,
        label: String,
    ): Result<Identity> =
        runCatching {
            // Validate inputs
            require(nsec.trim().isNotEmpty()) {
                "Nsec cannot be empty"
            }
            require(label.trim().isNotEmpty()) {
                "Identity label cannot be empty"
            }

            // Normalize nsec (trim, lowercase for validation)
            val normalizedNsec =
                nsec.trim()
                    .lowercase()

            // Validate nsec format
            require(normalizedNsec.startsWith("nsec1")) {
                "Invalid nsec format: must start with 'nsec1'"
            }

            // Import via repository (validates and decodes nsec)
            identityRepository.importFromNsec(
                nsec = normalizedNsec,
                label = label.trim(),
            ).getOrThrow()
        }
}
