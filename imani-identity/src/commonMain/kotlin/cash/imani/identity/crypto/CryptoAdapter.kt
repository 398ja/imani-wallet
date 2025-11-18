package cash.imani.identity.crypto

/**
 * Platform-independent cryptographic operations adapter.
 *
 * Provides secp256k1 keypair generation, Schnorr signatures, SHA-256 hashing,
 * and NIP-44 encryption for Nostr protocol compatibility.
 *
 * Implementation Strategy:
 * - **Web (jsMain)**: Uses Web Crypto API + @noble/secp256k1
 * - **Android (androidMain)**: Uses Android Keystore + BouncyCastle
 * - **iOS (iosMain)**: Uses iOS Keychain + CryptoKit
 *
 * Design: Expect/Actual pattern for platform-specific implementations
 */
interface CryptoAdapter {
    /**
     * Generates cryptographically secure random bytes.
     *
     * @param length Number of bytes to generate
     * @return Random byte array of specified length
     */
    suspend fun generateRandomBytes(length: Int): ByteArray

    /**
     * Computes SHA-256 hash of input data.
     *
     * @param data Input data to hash
     * @return 32-byte SHA-256 hash
     */
    suspend fun sha256(data: ByteArray): ByteArray

    /**
     * Generates a new secp256k1 keypair.
     *
     * Returns 32-byte public key (x-coordinate only, Nostr standard)
     * and 32-byte private key.
     *
     * @return KeyPair containing public and private keys
     */
    suspend fun generateKeypair(): KeyPair

    /**
     * Derives the public key from a private key.
     *
     * Uses secp256k1 elliptic curve multiplication to compute
     * the public key from the private key.
     *
     * @param privateKey 32-byte secp256k1 private key
     * @return 32-byte public key (x-coordinate only, Nostr standard)
     */
    suspend fun getPublicKey(privateKey: ByteArray): ByteArray

    /**
     * Creates a Schnorr signature over a message using secp256k1.
     *
     * Follows BIP340 Schnorr signature specification used by Nostr.
     *
     * @param privateKey 32-byte secp256k1 private key
     * @param message Message to sign (typically 32-byte hash)
     * @return 64-byte Schnorr signature
     */
    suspend fun schnorrSign(
        privateKey: ByteArray,
        message: ByteArray,
    ): ByteArray

    /**
     * Verifies a Schnorr signature.
     *
     * @param publicKey 32-byte secp256k1 public key (x-coordinate only)
     * @param message Original message that was signed
     * @param signature 64-byte Schnorr signature
     * @return true if signature is valid, false otherwise
     */
    suspend fun schnorrVerify(
        publicKey: ByteArray,
        message: ByteArray,
        signature: ByteArray,
    ): Boolean

    /**
     * Encrypts plaintext using NIP-44 encryption.
     *
     * NIP-44 is Nostr's standard for encrypted direct messages using:
     * - ECDH (secp256k1) for shared secret derivation
     * - HKDF-SHA256 for key derivation
     * - ChaCha20-Poly1305 for AEAD encryption
     * - Base64 encoding for ciphertext
     *
     * @param plaintext Text to encrypt
     * @param recipientPubkey Recipient's 32-byte public key (hex-encoded)
     * @param senderPrivkey Sender's 32-byte private key (hex-encoded)
     * @return Base64-encoded ciphertext with version prefix
     */
    suspend fun encryptNip44(
        plaintext: String,
        recipientPubkey: String,
        senderPrivkey: String,
    ): String

    /**
     * Decrypts NIP-44 encrypted ciphertext.
     *
     * @param ciphertext Base64-encoded ciphertext with version prefix
     * @param senderPubkey Sender's 32-byte public key (hex-encoded)
     * @param recipientPrivkey Recipient's 32-byte private key (hex-encoded)
     * @return Decrypted plaintext
     * @throws CryptoException if decryption fails
     */
    suspend fun decryptNip44(
        ciphertext: String,
        senderPubkey: String,
        recipientPrivkey: String,
    ): String
}

/**
 * Represents a secp256k1 keypair.
 *
 * @property publicKey 32-byte public key (x-coordinate only, per Nostr standard)
 * @property privateKey 32-byte private key
 */
data class KeyPair(
    val publicKey: ByteArray,
    val privateKey: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is KeyPair) return false
        return publicKey.contentEquals(other.publicKey) &&
            privateKey.contentEquals(other.privateKey)
    }

    override fun hashCode(): Int {
        var result = publicKey.contentHashCode()
        result = 31 * result + privateKey.contentHashCode()
        return result
    }
}

/**
 * Exception thrown when cryptographic operations fail.
 */
class CryptoException(message: String, cause: Throwable? = null) : Exception(message, cause)
