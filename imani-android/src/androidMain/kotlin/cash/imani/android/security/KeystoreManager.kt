package cash.imani.android.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Manages Android Keystore for encrypting private keys at rest.
 *
 * IMPORTANT: This class does NOT handle cryptographic operations (signing, verification).
 * Those are delegated to cashu-client's identity-domain module (Java code).
 *
 * This class only provides:
 * 1. Encryption of PrivateKey.bytes using Android Keystore (AES-GCM)
 * 2. Decryption of encrypted bytes to reconstruct PrivateKey
 *
 * All secp256k1 operations (key generation, Schnorr signatures, etc.) are handled
 * by the cashu-client Java library, NOT by this class.
 */
class KeystoreManager {
    private val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    /**
     * Encrypts PrivateKey.bytes using Android Keystore.
     *
     * @param privateKeyBytes The private key bytes from cashu-client's PrivateKey class
     * @param alias The keystore alias for this key (e.g., "identity_<id>")
     * @return Encrypted private key with IV prepended (first 12 bytes)
     *
     * Example usage:
     * ```kotlin
     * val identity = Identity.generateNew("My Identity")  // cashu-client Java class
     * val encryptedBytes = keystoreManager.encryptPrivateKey(
     *     identity.privateKey.bytes,
     *     "identity_${identity.id}"
     * )
     * // Store encryptedBytes in SQLDelight database
     * ```
     */
    fun encryptPrivateKey(
        privateKeyBytes: ByteArray,
        alias: String,
    ): ByteArray {
        require(privateKeyBytes.size == PRIVATE_KEY_SIZE) {
            "Private key must be exactly $PRIVATE_KEY_SIZE bytes, got ${privateKeyBytes.size}"
        }

        val secretKey = getOrCreateSecretKey(alias)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey)

        val iv = cipher.iv
        val encrypted = cipher.doFinal(privateKeyBytes)

        // Prepend IV to encrypted data (first 12 bytes for GCM)
        return iv + encrypted
    }

    /**
     * Decrypts PrivateKey.bytes using Android Keystore.
     *
     * @param encryptedData Encrypted private key with IV prepended
     * @param alias The keystore alias for this key
     * @return Decrypted private key bytes (to reconstruct cashu-client's PrivateKey)
     *
     * Example usage:
     * ```kotlin
     * val decryptedBytes = keystoreManager.decryptPrivateKey(
     *     encryptedData,
     *     "identity_$identityId"
     * )
     * val privateKey = PrivateKey(decryptedBytes)  // cashu-client Java class
     * ```
     */
    fun decryptPrivateKey(
        encryptedData: ByteArray,
        alias: String,
    ): ByteArray {
        require(encryptedData.size >= IV_SIZE) {
            "Encrypted data too short: ${encryptedData.size} bytes (expected at least $IV_SIZE)"
        }

        val secretKey = getOrCreateSecretKey(alias)

        // Extract IV (first 12 bytes for GCM)
        val iv = encryptedData.copyOfRange(0, IV_SIZE)
        val encrypted = encryptedData.copyOfRange(IV_SIZE, encryptedData.size)

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_LENGTH, iv))

        return cipher.doFinal(encrypted)
    }

    /**
     * Deletes a key from the Android Keystore.
     *
     * @param alias The keystore alias to delete
     */
    fun deleteKey(alias: String) {
        keyStore.deleteEntry(alias)
    }

    /**
     * Checks if a key exists in the Android Keystore.
     *
     * @param alias The keystore alias to check
     * @return true if the key exists, false otherwise
     */
    fun hasKey(alias: String): Boolean {
        return keyStore.containsAlias(alias)
    }

    /**
     * Gets or creates a secret key in the Android Keystore.
     *
     * The key is configured for AES-GCM encryption with:
     * - Block mode: GCM (Galois/Counter Mode)
     * - Padding: None (GCM doesn't require padding)
     * - User authentication: Optional (can be enabled for biometric unlock)
     */
    private fun getOrCreateSecretKey(alias: String): SecretKey {
        // Check if key already exists
        keyStore.getKey(alias, null)?.let { return it as SecretKey }

        // Generate new key
        val keyGenerator =
            KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES,
                ANDROID_KEYSTORE,
            )

        val spec =
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(KEY_SIZE)
                .setUserAuthenticationRequired(false) // Can be set to true for biometric unlock
                .build()

        keyGenerator.init(spec)
        return keyGenerator.generateKey()
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val KEY_SIZE = 256 // AES-256
        private const val IV_SIZE = 12 // GCM IV size
        private const val GCM_TAG_LENGTH = 128 // GCM authentication tag length
        private const val PRIVATE_KEY_SIZE = 32 // secp256k1 private key size
    }
}
