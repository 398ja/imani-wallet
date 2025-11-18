package cash.imani.identity

import cash.imani.identity.crypto.Bip39Adapter
import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.crypto.KeyPair
import cash.imani.identity.util.toHex

/**
 * Mock CryptoAdapter for testing.
 *
 * Provides deterministic crypto operations for testing without real cryptography.
 * NOT suitable for production use.
 */
class MockCryptoAdapter : CryptoAdapter {
    private var randomCounter = 0

    override suspend fun generateRandomBytes(length: Int): ByteArray {
        // Generate pseudo-random bytes for testing
        randomCounter++
        return ByteArray(length) { i ->
            ((i + randomCounter) % 256).toByte()
        }
    }

    override suspend fun sha256(data: ByteArray): ByteArray {
        // Simple hash for testing (NOT cryptographically secure)
        var hash = 0L
        for (byte in data) {
            hash = (hash * 31 + byte.toLong()) and 0xFFFFFFFF
        }
        // Return 32 bytes derived from simple hash
        return ByteArray(32) { i ->
            ((hash shr (i % 32)) and 0xFF).toByte()
        }
    }

    override suspend fun generateKeypair(): KeyPair {
        val privKey = generateRandomBytes(32)
        // Derive public key from private key (mock - not real crypto!)
        val pubKey = getPublicKey(privKey)
        return KeyPair(pubKey, privKey)
    }

    override suspend fun getPublicKey(privateKey: ByteArray): ByteArray {
        require(privateKey.size == 32) { "Private key must be 32 bytes" }
        // Derive public key from private key (mock - not real crypto!)
        // Use SHA-256 for deterministic derivation
        return sha256(privateKey)
    }

    // Store signatures for verification (mock only - not how real crypto works!)
    private val signatures = mutableMapOf<String, Pair<ByteArray, ByteArray>>()

    override suspend fun schnorrSign(
        privateKey: ByteArray,
        message: ByteArray,
    ): ByteArray {
        // Simple mock signature: hash(privKey || message)
        val combined = privateKey + message
        val hash1 = sha256(combined)
        val hash2 = sha256(hash1)
        val signature = hash1 + hash2

        // Store the signature with its message and derive "public key" from private key
        // (In mock, we'll just use privKey as identifier)
        val pubKey = sha256(privateKey) // Derive mock public key
        signatures[signature.toHex()] = Pair(pubKey, message)

        return signature
    }

    override suspend fun schnorrVerify(
        publicKey: ByteArray,
        message: ByteArray,
        signature: ByteArray,
    ): Boolean {
        // Mock verification: check if signature was created for this message
        // Real verification would use actual Schnorr math
        if (signature.size != 64) return false

        val stored = signatures[signature.toHex()] ?: return false
        val (storedPubKey, storedMessage) = stored

        return storedPubKey.contentEquals(publicKey) && storedMessage.contentEquals(message)
    }

    override suspend fun encryptNip44(
        plaintext: String,
        recipientPubkey: String,
        senderPrivkey: String,
    ): String {
        // Mock encryption
        return "encrypted:$plaintext"
    }

    override suspend fun decryptNip44(
        ciphertext: String,
        senderPubkey: String,
        recipientPrivkey: String,
    ): String {
        // Mock decryption
        return ciphertext.removePrefix("encrypted:")
    }
}

/**
 * Mock Bip39Adapter for testing.
 *
 * Provides deterministic mnemonic operations for testing without real BIP39.
 * NOT suitable for production use.
 */
class MockBip39Adapter : Bip39Adapter {
    override suspend fun entropyToMnemonic(entropyBytes: ByteArray): String {
        // Mock: Generate deterministic "words" from entropy
        val wordCount =
            when (entropyBytes.size) {
                16 -> 12
                32 -> 24
                else -> throw IllegalArgumentException("Entropy must be 16 or 32 bytes")
            }

        return (1..wordCount).joinToString(" ") { i ->
            "word${i % 10}"
        }
    }

    override suspend fun mnemonicToSeed(
        mnemonic: String,
        passphrase: String,
    ): ByteArray {
        // Mock: Generate deterministic seed from mnemonic
        val combined = "$mnemonic$passphrase"
        var hash = 0L
        for (char in combined) {
            hash = (hash * 31 + char.code.toLong()) and 0xFFFFFFFF
        }
        return ByteArray(64) { i ->
            ((hash shr (i % 32)) and 0xFF).toByte()
        }
    }

    override suspend fun validateMnemonic(mnemonic: String): Boolean {
        // Mock: Accept any mnemonic with 12 or 24 words
        val words = mnemonic.trim().split(Regex("\\s+"))
        return words.size == 12 || words.size == 24
    }

    override suspend fun derivePrivateKey(
        seed: ByteArray,
        path: String,
    ): ByteArray {
        // Mock: Derive private key from seed (simplified)
        // Real implementation would use BIP32 derivation
        var hash = 0L
        for (byte in seed) {
            hash = (hash * 31 + byte.toLong()) and 0xFFFFFFFF
        }
        for (char in path) {
            hash = (hash * 31 + char.code.toLong()) and 0xFFFFFFFF
        }
        return ByteArray(32) { i ->
            ((hash shr (i % 32)) and 0xFF).toByte()
        }
    }
}
