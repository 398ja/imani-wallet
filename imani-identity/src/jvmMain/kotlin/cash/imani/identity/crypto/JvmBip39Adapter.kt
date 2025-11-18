package cash.imani.identity.crypto

import java.security.MessageDigest

/**
 * JVM implementation of Bip39Adapter.
 *
 * Phase 0/1 Status: Basic implementation for testing.
 * Uses simple HMAC-SHA512 for key derivation (NOT BIP32 compliant).
 *
 * Phase 2+ TODO: Full BIP39/BIP32 implementation with proper libraries
 */
actual fun createBip39Adapter(): Bip39Adapter = JvmBip39Adapter()

class JvmBip39Adapter : Bip39Adapter {
    override suspend fun entropyToMnemonic(entropyBytes: ByteArray): String {
        // TODO Phase 2: Implement with proper BIP39 library
        // For now, return a mock mnemonic for testing
        val wordCount =
            when (entropyBytes.size) {
                16 -> 12
                32 -> 24
                else -> throw IllegalArgumentException("Entropy must be 16 or 32 bytes")
            }
        return List(wordCount) { "word" }.joinToString(" ")
    }

    override suspend fun mnemonicToSeed(
        mnemonic: String,
        passphrase: String,
    ): ByteArray {
        // TODO Phase 2: Implement PBKDF2 with 2048 iterations
        // For now, use simple SHA-512
        val input = "$mnemonic$passphrase".toByteArray()
        val digest = MessageDigest.getInstance("SHA-512")
        return digest.digest(input)
    }

    override suspend fun validateMnemonic(mnemonic: String): Boolean {
        // TODO Phase 2: Implement proper BIP39 validation
        // For now, just check word count
        val words = mnemonic.trim().split("\\s+".toRegex())
        return words.size in setOf(12, 15, 18, 21, 24)
    }

    override suspend fun derivePrivateKey(
        seed: ByteArray,
        path: String,
    ): ByteArray {
        // TODO Phase 2: Implement BIP32 derivation
        // For now, use first 32 bytes of seed
        if (seed.size < 32) {
            throw IllegalArgumentException("Seed must be at least 32 bytes")
        }
        return seed.copyOfRange(0, 32)
    }
}
