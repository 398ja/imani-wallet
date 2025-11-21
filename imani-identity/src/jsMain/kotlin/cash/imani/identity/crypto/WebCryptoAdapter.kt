package cash.imani.identity.crypto

import kotlinx.browser.window
import kotlinx.coroutines.await
import org.khronos.webgl.ArrayBuffer
import org.khronos.webgl.Uint8Array
import kotlin.js.Promise
import cash.imani.identity.crypto.getPublicKey as nobleGetPublicKey

/**
 * Web Crypto API implementation of CryptoAdapter.
 *
 * Uses:
 * - Web Crypto API (window.crypto.subtle) for SHA-256 and random number generation
 * - @noble/secp256k1 for secp256k1 keypair generation and Schnorr signatures
 * - @noble/hashes for HKDF key derivation (NIP-44)
 * - chacha20-poly1305 for AEAD encryption (NIP-44)
 *
 * Note: Requires NPM dependencies in package.json:
 * - @noble/secp256k1: ^2.0.0
 * - @noble/hashes: ^1.3.3
 */
class WebCryptoAdapter : CryptoAdapter {
    // Access browser's Web Crypto API
    private val crypto: dynamic
        get() = window.asDynamic().crypto

    private val subtle: dynamic
        get() = crypto.subtle

    override suspend fun generateRandomBytes(length: Int): ByteArray {
        val array = Uint8Array(length)
        crypto.getRandomValues(array)
        return ByteArray(length) { i -> array.asDynamic()[i].unsafeCast<Byte>() }
    }

    override suspend fun sha256(data: ByteArray): ByteArray {
        // Convert ByteArray to Uint8Array for Web Crypto API
        val uint8Array = Uint8Array(data.size)
        for (i in data.indices) {
            uint8Array.asDynamic()[i] = data[i]
        }

        // Use Web Crypto API's SubtleCrypto.digest
        val hashBuffer: ArrayBuffer =
            subtle.digest("SHA-256", uint8Array)
                .unsafeCast<Promise<ArrayBuffer>>()
                .await()

        // Convert ArrayBuffer back to ByteArray
        val resultArray = Uint8Array(hashBuffer)
        return ByteArray(resultArray.length) { i -> resultArray.asDynamic()[i].unsafeCast<Byte>() }
    }

    override suspend fun generateKeypair(): KeyPair {
        try {
            // Generate 32 random bytes for private key
            val privKeyBytes = generateRandomBytes(32)

            // Derive public key from private key
            val pubKeyBytes = getPublicKey(privKeyBytes)

            return KeyPair(pubKeyBytes, privKeyBytes)
        } catch (e: Exception) {
            throw CryptoException("Failed to generate keypair", e)
        }
    }

    override suspend fun getPublicKey(privateKey: ByteArray): ByteArray {
        try {
            require(privateKey.size == 32) { "Private key must be 32 bytes" }

            // Use @noble/secp256k1 to derive public key
            // getPublicKey returns 33-byte compressed key, we need x-coordinate only (32 bytes)
            val privKeyArray = privateKey.toUint8Array()
            val pubKeyCompressed = nobleGetPublicKey(privKeyArray, true)

            // Extract x-coordinate (skip first byte which is 0x02 or 0x03 compression flag)
            return ByteArray(32) { i -> pubKeyCompressed.asDynamic()[i + 1].unsafeCast<Byte>() }
        } catch (e: Exception) {
            throw CryptoException("Failed to derive public key from private key", e)
        }
    }

    override suspend fun schnorrSign(
        privateKey: ByteArray,
        message: ByteArray,
    ): ByteArray {
        try {
            // Convert ByteArray to Uint8Array for noble library
            val privKeyArray = privateKey.toUint8Array()
            val messageArray = message.toUint8Array()

            // Use @noble/secp256k1's Schnorr signature (BIP340)
            val signature = schnorr.sign(messageArray, privKeyArray)

            // Convert result to ByteArray
            return ByteArray(signature.length) { i -> signature.asDynamic()[i].unsafeCast<Byte>() }
        } catch (e: Exception) {
            throw CryptoException("Failed to sign message", e)
        }
    }

    override suspend fun schnorrVerify(
        publicKey: ByteArray,
        message: ByteArray,
        signature: ByteArray,
    ): Boolean {
        return try {
            val pubKeyArray = publicKey.toUint8Array()
            val messageArray = message.toUint8Array()
            val sigArray = signature.toUint8Array()

            // Schnorr verification returns boolean
            schnorr.verify(sigArray, messageArray, pubKeyArray)
        } catch (e: Exception) {
            false // Invalid signature
        }
    }

    override suspend fun encryptNip44(
        plaintext: String,
        recipientPubkey: String,
        senderPrivkey: String,
    ): String {
        // TODO: Implement NIP-44 encryption in Phase 1 when needed for DMs
        // Requires:
        // 1. ECDH to compute shared secret
        // 2. HKDF-SHA256 for key derivation
        // 3. ChaCha20-Poly1305 for AEAD encryption
        // 4. Base64 encoding with version prefix
        throw NotImplementedError("NIP-44 encryption will be implemented in Phase 1.2")
    }

    override suspend fun decryptNip44(
        ciphertext: String,
        senderPubkey: String,
        recipientPrivkey: String,
    ): String {
        // TODO: Implement NIP-44 decryption in Phase 1 when needed for DMs
        throw NotImplementedError("NIP-44 decryption will be implemented in Phase 1.2")
    }

    /**
     * Helper to convert Kotlin ByteArray to JavaScript Uint8Array.
     */
    private fun ByteArray.toUint8Array(): Uint8Array {
        val uint8Array = Uint8Array(this.size)
        for (i in this.indices) {
            uint8Array.asDynamic()[i] = this[i]
        }
        return uint8Array
    }
}
