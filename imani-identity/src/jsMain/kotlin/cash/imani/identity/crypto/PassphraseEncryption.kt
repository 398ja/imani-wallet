package cash.imani.identity.crypto

import cash.imani.identity.util.toHex
import kotlinx.coroutines.await
import org.khronos.webgl.ArrayBuffer
import org.khronos.webgl.Uint8Array
import org.khronos.webgl.get
import kotlin.js.Promise
import kotlin.random.Random

/**
 * External declarations for Web Crypto API.
 */
external class CryptoKey

/**
 * Passphrase-based encryption using PBKDF2 + AES-GCM for secure storage.
 *
 * Security Features:
 * - PBKDF2 key derivation with 600,000 iterations (OWASP 2023 recommendation)
 * - AES-256-GCM authenticated encryption
 * - Random 96-bit IV per encryption
 * - Random 128-bit salt per passphrase
 * - Web Crypto API for cryptographic operations
 *
 * Storage Format:
 * - Encrypted data: `{salt_hex}:{iv_hex}:{ciphertext_hex}`
 * - Salt: 16 bytes (128 bits)
 * - IV: 12 bytes (96 bits, recommended for GCM)
 * - Ciphertext: Variable length + 16 byte auth tag
 *
 * Usage:
 * ```kotlin
 * val encryption = PassphraseEncryption()
 * val encrypted = encryption.encrypt(data, "my-secure-passphrase")
 * val decrypted = encryption.decrypt(encrypted, "my-secure-passphrase")
 * ```
 *
 * Phase 3 Enhancement:
 * - Add optional biometric authentication
 * - Add key rotation support
 * - Add secure passphrase strength validation
 */
class PassphraseEncryption {
    companion object {
        /** PBKDF2 iteration count (OWASP 2023 recommendation for PBKDF2-SHA256) */
        private const val PBKDF2_ITERATIONS = 600_000

        /** Salt length in bytes */
        private const val SALT_LENGTH = 16

        /** IV length in bytes (96 bits recommended for GCM) */
        private const val IV_LENGTH = 12

        /** AES key length in bits */
        private const val AES_KEY_LENGTH = 256
    }

    /**
     * Encrypts data using passphrase-derived key via PBKDF2.
     *
     * @param data Plaintext bytes to encrypt
     * @param passphrase User passphrase for key derivation
     * @return Encrypted string in format: "{salt}:{iv}:{ciphertext}" (hex-encoded)
     */
    suspend fun encrypt(
        data: ByteArray,
        passphrase: String,
    ): String {
        // Generate random salt
        val salt = generateRandomBytes(SALT_LENGTH)

        // Derive encryption key from passphrase
        val key = deriveKey(passphrase, salt)

        // Generate random IV
        val iv = generateRandomBytes(IV_LENGTH)

        // Encrypt data using AES-GCM
        val ciphertext = encryptWithKey(data, key, iv)

        // Return combined format: salt:iv:ciphertext
        return "${salt.toHex()}:${iv.toHex()}:${ciphertext.toHex()}"
    }

    /**
     * Decrypts data encrypted with encrypt().
     *
     * @param encryptedData Encrypted string in format: "{salt}:{iv}:{ciphertext}"
     * @param passphrase User passphrase used for encryption
     * @return Decrypted plaintext bytes
     * @throws IllegalArgumentException if format is invalid
     * @throws Exception if decryption fails (wrong passphrase or corrupted data)
     */
    suspend fun decrypt(
        encryptedData: String,
        passphrase: String,
    ): ByteArray {
        // Parse encrypted data format
        val parts = encryptedData.split(":")
        require(parts.size == 3) {
            "Invalid encrypted data format. Expected: {salt}:{iv}:{ciphertext}"
        }

        val salt = parts[0].hexToByteArray()
        val iv = parts[1].hexToByteArray()
        val ciphertext = parts[2].hexToByteArray()

        // Derive the same key from passphrase + salt
        val key = deriveKey(passphrase, salt)

        // Decrypt using AES-GCM
        return decryptWithKey(ciphertext, key, iv)
    }

    /**
     * Derives encryption key from passphrase using PBKDF2.
     *
     * @param passphrase User passphrase
     * @param salt Random salt bytes
     * @return CryptoKey for AES-GCM encryption
     */
    private suspend fun deriveKey(
        passphrase: String,
        salt: ByteArray,
    ): CryptoKey {
        // Import passphrase as CryptoKey for PBKDF2
        val passphraseBytes = passphrase.encodeToByteArray()
        val passphraseKey = importPassphrase(passphraseBytes)

        // Derive key using PBKDF2
        val derivedKeyBuffer =
            js(
                """
            crypto.subtle.deriveKey(
                {
                    name: 'PBKDF2',
                    salt: new Uint8Array(salt),
                    iterations: PBKDF2_ITERATIONS,
                    hash: 'SHA-256'
                },
                passphraseKey,
                {
                    name: 'AES-GCM',
                    length: AES_KEY_LENGTH
                },
                false, // not extractable
                ['encrypt', 'decrypt']
            )
            """,
            ) as Promise<CryptoKey>

        return derivedKeyBuffer.await()
    }

    /**
     * Imports passphrase bytes as CryptoKey for PBKDF2.
     */
    private suspend fun importPassphrase(passphraseBytes: ByteArray): CryptoKey {
        val promise =
            js(
                """
            crypto.subtle.importKey(
                'raw',
                new Uint8Array(passphraseBytes),
                { name: 'PBKDF2' },
                false,
                ['deriveKey']
            )
            """,
            ) as Promise<CryptoKey>

        return promise.await()
    }

    /**
     * Encrypts data with AES-GCM using the provided key.
     */
    private suspend fun encryptWithKey(
        data: ByteArray,
        key: CryptoKey,
        iv: ByteArray,
    ): ByteArray {
        val encryptedBuffer =
            js(
                """
            crypto.subtle.encrypt(
                {
                    name: 'AES-GCM',
                    iv: new Uint8Array(iv)
                },
                key,
                new Uint8Array(data)
            )
            """,
            ) as Promise<ArrayBuffer>

        val arrayBuffer = encryptedBuffer.await()
        return Uint8Array(arrayBuffer).toByteArray()
    }

    /**
     * Decrypts AES-GCM encrypted data.
     */
    private suspend fun decryptWithKey(
        ciphertext: ByteArray,
        key: CryptoKey,
        iv: ByteArray,
    ): ByteArray {
        val decryptedBuffer =
            js(
                """
            crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: new Uint8Array(iv)
                },
                key,
                new Uint8Array(ciphertext)
            )
            """,
            ) as Promise<ArrayBuffer>

        val arrayBuffer = decryptedBuffer.await()
        return Uint8Array(arrayBuffer).toByteArray()
    }

    /**
     * Generates cryptographically secure random bytes.
     */
    private fun generateRandomBytes(length: Int): ByteArray {
        val bytes = ByteArray(length)
        Random.Default.nextBytes(bytes)
        return bytes
    }

    /**
     * Converts hex string to byte array.
     */
    private fun String.hexToByteArray(): ByteArray {
        check(length % 2 == 0) { "Hex string must have even length" }
        return chunked(2)
            .map { it.toInt(16).toByte() }
            .toByteArray()
    }
}

/**
 * Converts Uint8Array to ByteArray.
 */
private fun Uint8Array.toByteArray(): ByteArray {
    val result = ByteArray(length)
    for (i in 0 until length) {
        result[i] = get(i)
    }
    return result
}
