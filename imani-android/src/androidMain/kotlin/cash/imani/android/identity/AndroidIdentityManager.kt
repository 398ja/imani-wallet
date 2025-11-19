package cash.imani.android.identity

import cash.imani.android.security.KeystoreManager
import cash.imani.identity.domain.Identity
import cash.imani.identity.util.hexToBytes
import cash.imani.identity.util.toHex
import kotlinx.datetime.Clock

/**
 * Android-specific wrapper for Identity management.
 *
 * This class provides Android Keystore integration for secure private key storage.
 * It wraps the imani-identity domain model and adds Android-specific security features.
 *
 * ARCHITECTURE NOTE:
 * This is a thin Android wrapper that:
 * 1. Uses KeystoreManager to encrypt private keys at rest (Android Keystore AES-GCM)
 * 2. Delegates crypto operations to platform-specific crypto adapters
 * 3. Stores encrypted data in SQLDelight database (Task 4.2.2)
 *
 * In the future, this could be adapted to wrap cashu-client's Java Identity class
 * for ≥90% code reuse on Android (which runs on JVM).
 *
 * @property keystoreManager Android Keystore manager for key encryption
 */
class AndroidIdentityManager(
    private val keystoreManager: KeystoreManager
) {

    /**
     * Encrypts an identity's private key for secure storage.
     *
     * @param identity The identity to encrypt
     * @return Encrypted private key bytes (IV + ciphertext)
     *
     * Usage:
     * ```kotlin
     * val identity = Identity(...) // from create or import
     * val encryptedPrivKey = manager.encryptPrivateKey(identity)
     * database.identityQueries.insert(
     *     id = identity.id,
     *     label = identity.label,
     *     publicKey = identity.publicKey,
     *     encryptedPrivateKey = encryptedPrivKey,
     *     ...
     * )
     * ```
     */
    fun encryptPrivateKey(identity: Identity): ByteArray {
        val privateKeyBytes = identity.privateKey.hexToBytes()
        return keystoreManager.encryptPrivateKey(
            privateKeyBytes,
            getKeystoreAlias(identity.id)
        )
    }

    /**
     * Decrypts a private key from secure storage.
     *
     * @param identityId The identity ID
     * @param encryptedPrivateKey The encrypted private key bytes
     * @return Decrypted private key as hex string
     *
     * Usage:
     * ```kotlin
     * val record = database.identityQueries.selectById(id).executeAsOne()
     * val privateKeyHex = manager.decryptPrivateKey(
     *     record.id,
     *     record.encryptedPrivateKey
     * )
     * val identity = Identity(
     *     id = record.id,
     *     label = record.label,
     *     publicKey = record.publicKey,
     *     privateKey = privateKeyHex,  // Decrypted
     *     ...
     * )
     * ```
     */
    fun decryptPrivateKey(identityId: String, encryptedPrivateKey: ByteArray): String {
        val privateKeyBytes = keystoreManager.decryptPrivateKey(
            encryptedPrivateKey,
            getKeystoreAlias(identityId)
        )
        return privateKeyBytes.toHex()
    }

    /**
     * Securely deletes an identity's private key from Android Keystore.
     *
     * @param identityId The identity ID
     *
     * IMPORTANT: Call this when deleting an identity from the database to ensure
     * the Keystore entry is also removed.
     */
    fun deletePrivateKey(identityId: String) {
        keystoreManager.deleteKey(getKeystoreAlias(identityId))
    }

    /**
     * Checks if a private key exists in Android Keystore.
     *
     * @param identityId The identity ID
     * @return true if the key exists in Keystore, false otherwise
     */
    fun hasPrivateKey(identityId: String): Boolean {
        return keystoreManager.hasKey(getKeystoreAlias(identityId))
    }

    /**
     * Creates an identity with encrypted private key storage.
     *
     * This is a convenience method that combines identity creation with
     * automatic private key encryption.
     *
     * @param identity The identity to store (with plaintext private key)
     * @return Tuple of (identity, encryptedPrivateKey) ready for database storage
     *
     * Usage:
     * ```kotlin
     * val identity = createIdentityUseCase(label).getOrThrow()
     * val (id, encryptedKey) = manager.prepareForStorage(identity)
     * database.identityQueries.insert(
     *     id = id.id,
     *     label = id.label,
     *     publicKey = id.publicKey,
     *     encryptedPrivateKey = encryptedKey,
     *     createdAt = id.createdAt.toEpochMilliseconds(),
     *     lastUsedAt = id.lastUsedAt?.toEpochMilliseconds()
     * )
     * ```
     */
    fun prepareForStorage(identity: Identity): Pair<Identity, ByteArray> {
        val encryptedPrivKey = encryptPrivateKey(identity)

        // Return identity without private key in memory (security best practice)
        val secureIdentity = identity.copy(
            privateKey = "" // Clear from memory after encryption
        )

        return secureIdentity to encryptedPrivKey
    }

    /**
     * Updates the last used timestamp for an identity.
     *
     * @param identity The identity to update
     * @return Updated identity with current timestamp
     */
    fun markAsUsed(identity: Identity): Identity {
        return identity.withUpdatedUsage()
    }

    /**
     * Generates the Android Keystore alias for an identity.
     *
     * Format: "identity_{id}"
     * Example: "identity_550e8400-e29b-41d4-a716-446655440000"
     */
    private fun getKeystoreAlias(identityId: String): String {
        return "identity_$identityId"
    }

    companion object {
        /**
         * Validates that a private key hex string is the correct length.
         *
         * @throws IllegalArgumentException if the key is not 64 hex characters
         */
        fun validatePrivateKeyHex(privateKeyHex: String) {
            require(privateKeyHex.length == 64) {
                "Private key must be 64 hex characters (32 bytes), got ${privateKeyHex.length}"
            }
        }
    }
}
