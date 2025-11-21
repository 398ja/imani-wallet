package cash.imani.android.adapter

import cash.imani.identity.repository.IdentityRepository
import kotlinx.coroutines.runBlocking
import nostr.base.PrivateKey
import nostr.base.PublicKey
import xyz.tcheeric.wallet.core.security.IdentityKey
import xyz.tcheeric.wallet.core.security.IdentityKeyService

/**
 * Android implementation of cashu-client IdentityKeyService.
 *
 * Wraps AndroidIdentityRepository to provide IdentityKey for cashu-client VoucherService.
 * Converts between imani-identity domain models and cashu-client IdentityKey format.
 *
 * **Design Decision**: Extends IdentityKeyService and overrides loadOrCreate() to use
 * AndroidIdentityRepository instead of file-based storage.
 *
 * **Thread Safety**: loadOrCreate() is synchronized to match parent class behavior.
 *
 * **Nostr Integration**: Uses nostr-java PrivateKey/PublicKey types required by
 * cashu-client IdentityKey, constructed from raw bytes.
 *
 * **Active Identity Strategy**: Uses the first identity in the repository as the active one.
 * If no identities exist, auto-creates a "Default" identity.
 *
 * @property identityRepository AndroidIdentityRepository instance
 *
 * @see xyz.tcheeric.wallet.core.security.IdentityKeyService
 * @see cash.imani.identity.repository.IdentityRepository
 */
class AndroidIdentityKeyService(
    private val identityRepository: IdentityRepository,
) : IdentityKeyService() {
    /**
     * Loads active identity or creates new one if none exists.
     *
     * Overrides file-based storage with AndroidIdentityRepository integration.
     *
     * **Blocking Coroutines**: Uses runBlocking since parent class is synchronous.
     * This is acceptable as identity operations are infrequent (app startup only).
     *
     * @return IdentityKey containing JCA and Nostr key pairs
     * @throws IllegalStateException if no active identity and auto-creation fails
     */
    @Synchronized
    override fun loadOrCreate(): IdentityKey =
        runBlocking {
            // Get first identity from repository (acts as "active" identity)
            val identities =
                identityRepository.listIdentities().getOrElse { error ->
                    throw IllegalStateException(
                        "Failed to load identities from repository. " +
                            "Reason: ${error.message}. " +
                            "Suggestion: Verify database is initialized and accessible.",
                        error,
                    )
                }

            val activeIdentity =
                identities.firstOrNull()
                    ?: createDefaultIdentity()

            // Convert to cashu-client IdentityKey format
            convertToIdentityKey(activeIdentity)
        }

    /**
     * Creates a default identity if none exists.
     *
     * **Fallback Strategy**: Auto-creates "Default" identity for seamless first-run.
     *
     * @return Active identity after creation
     * @throws IllegalStateException if creation fails
     */
    private suspend fun createDefaultIdentity(): cash.imani.identity.domain.Identity {
        val createResult = identityRepository.createIdentity("Default")

        return createResult.getOrElse { error ->
            throw IllegalStateException(
                "Failed to create default identity for cashu-client. " +
                    "Reason: ${error.message}. " +
                    "Suggestion: Ensure Android Keystore is accessible and identity repository is initialized.",
                error,
            )
        }
    }

    /**
     * Converts imani-identity Identity to cashu-client IdentityKey.
     *
     * **Key Conversion**:
     * 1. Extract raw bytes from hex-encoded private/public keys
     * 2. Create nostr-java PrivateKey/PublicKey from bytes
     * 3. Wrap in IdentityKey using fromNostrJava() factory
     *
     * @param identity imani-identity domain model (already includes decrypted private key)
     * @return IdentityKey for cashu-client VoucherService
     */
    private suspend fun convertToIdentityKey(identity: cash.imani.identity.domain.Identity): IdentityKey {
        // Convert hex private key to bytes
        val privateKeyBytes = hexToBytes(identity.privateKey)

        // Convert hex public key to bytes
        val publicKeyBytes = hexToBytes(identity.publicKey)

        // Create nostr-java key objects (required by cashu-client IdentityKey)
        val nostrPrivateKey = PrivateKey(privateKeyBytes)
        val nostrPublicKey = PublicKey(publicKeyBytes)

        // Use cashu-client factory method
        return IdentityKey.fromNostrJava(nostrPrivateKey, nostrPublicKey)
    }

    /**
     * Converts hex string to byte array.
     *
     * @param hex Hex-encoded string (must be even length)
     * @return Decoded byte array
     * @throws IllegalArgumentException if hex string is invalid
     */
    private fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0) {
            "Hex string must have even length, got ${hex.length}"
        }

        return hex.chunked(2)
            .map { it.toInt(16).toByte() }
            .toByteArray()
    }
}
