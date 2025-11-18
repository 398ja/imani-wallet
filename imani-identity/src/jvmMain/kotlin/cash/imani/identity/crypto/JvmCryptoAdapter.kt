package cash.imani.identity.crypto

import java.security.MessageDigest
import java.security.SecureRandom

/**
 * JVM implementation of CryptoAdapter.
 *
 * Phase 0/1 Status: Basic implementation for compilation and testing.
 * Uses Java standard library for SHA-256 and random number generation.
 *
 * Phase 2+ TODO: Full implementation with BouncyCastle for secp256k1:
 * - Proper secp256k1 keypair generation
 * - BIP340 Schnorr signatures
 * - NIP-44 encryption with ChaCha20-Poly1305
 *
 * Current Limitations:
 * - Schnorr operations throw NotImplementedError (use Web for Phase 1)
 * - This adapter is primarily for server-side utilities, not cryptographic operations
 */
class JvmCryptoAdapter : CryptoAdapter {
    private val secureRandom = SecureRandom()
    private val messageDigest = MessageDigest.getInstance("SHA-256")

    override suspend fun generateRandomBytes(length: Int): ByteArray {
        val bytes = ByteArray(length)
        secureRandom.nextBytes(bytes)
        return bytes
    }

    override suspend fun sha256(data: ByteArray): ByteArray {
        return messageDigest.digest(data)
    }

    override suspend fun generateKeypair(): KeyPair {
        // TODO Phase 2: Implement with BouncyCastle secp256k1
        // For now, generate random 32-byte keys for testing
        val privateKey = generateRandomBytes(32)
        val publicKey = generateRandomBytes(32)
        return KeyPair(publicKey, privateKey)
    }

    override suspend fun getPublicKey(privateKey: ByteArray): ByteArray {
        // TODO Phase 2: Implement proper secp256k1 public key derivation with BouncyCastle
        throw NotImplementedError(
            "Public key derivation not yet implemented for JVM. " +
                "Use Web platform (Phase 1) or wait for Phase 2 JVM implementation.",
        )
    }

    override suspend fun schnorrSign(
        privateKey: ByteArray,
        message: ByteArray,
    ): ByteArray {
        // TODO Phase 2: Implement BIP340 Schnorr with BouncyCastle
        throw NotImplementedError(
            "Schnorr signatures not yet implemented for JVM. " +
                "Use Web platform (Phase 1) or wait for Phase 2 JVM implementation.",
        )
    }

    override suspend fun schnorrVerify(
        publicKey: ByteArray,
        message: ByteArray,
        signature: ByteArray,
    ): Boolean {
        // TODO Phase 2: Implement BIP340 Schnorr verification with BouncyCastle
        throw NotImplementedError(
            "Schnorr verification not yet implemented for JVM. " +
                "Use Web platform (Phase 1) or wait for Phase 2 JVM implementation.",
        )
    }

    override suspend fun encryptNip44(
        plaintext: String,
        recipientPubkey: String,
        senderPrivkey: String,
    ): String {
        // TODO Phase 2: Implement NIP-44 with BouncyCastle
        throw NotImplementedError("NIP-44 encryption not yet implemented for JVM")
    }

    override suspend fun decryptNip44(
        ciphertext: String,
        senderPubkey: String,
        recipientPrivkey: String,
    ): String {
        // TODO Phase 2: Implement NIP-44 with BouncyCastle
        throw NotImplementedError("NIP-44 decryption not yet implemented for JVM")
    }
}
