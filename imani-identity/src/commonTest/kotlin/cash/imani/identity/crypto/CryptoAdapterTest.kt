package cash.imani.identity.crypto

import cash.imani.identity.util.toHex
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Unit tests for CryptoAdapter implementations.
 *
 * These tests verify the cryptographic operations contract:
 * - Random number generation produces non-zero bytes
 * - SHA-256 produces consistent 32-byte hashes
 * - Keypair generation produces valid keys
 * - Schnorr signatures verify correctly
 * - Invalid signatures fail verification
 */
class CryptoAdapterTest {
    /**
     * Tests that generateRandomBytes produces non-deterministic output.
     */
    @Test
    fun `generateRandomBytes produces different values on successive calls`() =
        runTest {
            // Note: This test uses a mock adapter since we can't run actual
            // Web Crypto API in JVM tests. In Phase 1, we'll add JS-specific tests.
            val adapter = MockCryptoAdapter()

            // Given: Two calls to generate random bytes
            val bytes1 = adapter.generateRandomBytes(32)
            val bytes2 = adapter.generateRandomBytes(32)

            // Then: Should produce different values (with very high probability)
            assertNotEquals(bytes1.toHex(), bytes2.toHex())
        }

    /**
     * Tests that generateRandomBytes respects the requested length.
     */
    @Test
    fun `generateRandomBytes returns correct length`() =
        runTest {
            val adapter = MockCryptoAdapter()

            // When: Generating bytes of various lengths
            val bytes16 = adapter.generateRandomBytes(16)
            val bytes32 = adapter.generateRandomBytes(32)
            val bytes64 = adapter.generateRandomBytes(64)

            // Then: Should return exact lengths
            assertEquals(16, bytes16.size)
            assertEquals(32, bytes32.size)
            assertEquals(64, bytes64.size)
        }

    /**
     * Tests that SHA-256 produces consistent 32-byte hashes.
     */
    @Test
    fun `sha256 produces consistent 32-byte hash`() =
        runTest {
            val adapter = MockCryptoAdapter()

            // Given: Same input data
            val data = "Hello, Imani Wallet!".encodeToByteArray()

            // When: Hashing twice
            val hash1 = adapter.sha256(data)
            val hash2 = adapter.sha256(data)

            // Then: Hashes should be identical and 32 bytes
            assertEquals(32, hash1.size)
            assertEquals(hash1.toHex(), hash2.toHex())
        }

    /**
     * Tests that SHA-256 produces different hashes for different inputs.
     */
    @Test
    fun `sha256 produces different hashes for different inputs`() =
        runTest {
            val adapter = MockCryptoAdapter()

            // Given: Two different messages
            val data1 = "Message 1".encodeToByteArray()
            val data2 = "Message 2".encodeToByteArray()

            // When: Hashing both
            val hash1 = adapter.sha256(data1)
            val hash2 = adapter.sha256(data2)

            // Then: Hashes should differ
            assertNotEquals(hash1.toHex(), hash2.toHex())
        }

    /**
     * Tests that keypair generation produces valid 32-byte keys.
     */
    @Test
    fun `generateKeypair produces 32-byte keys`() =
        runTest {
            val adapter = MockCryptoAdapter()

            // When: Generating a keypair
            val keypair = adapter.generateKeypair()

            // Then: Both keys should be 32 bytes (Nostr standard)
            assertEquals(32, keypair.publicKey.size)
            assertEquals(32, keypair.privateKey.size)
        }

    /**
     * Tests that successive keypair generations produce different keys.
     */
    @Test
    fun `generateKeypair produces unique keys`() =
        runTest {
            val adapter = MockCryptoAdapter()

            // When: Generating two keypairs
            val keypair1 = adapter.generateKeypair()
            val keypair2 = adapter.generateKeypair()

            // Then: Keys should be different
            assertNotEquals(keypair1.publicKey.toHex(), keypair2.publicKey.toHex())
            assertNotEquals(keypair1.privateKey.toHex(), keypair2.privateKey.toHex())
        }

    /**
     * Tests that Schnorr signature verification succeeds for valid signatures.
     */
    @Test
    fun `schnorrSign and schnorrVerify work correctly`() =
        runTest {
            val adapter = MockCryptoAdapter()

            // Given: A keypair and a message
            val keypair = adapter.generateKeypair()
            val message = adapter.sha256("Test message".encodeToByteArray())

            // When: Signing the message
            val signature = adapter.schnorrSign(keypair.privateKey, message)

            // Then: Signature should verify
            assertTrue(adapter.schnorrVerify(keypair.publicKey, message, signature))
        }

    /**
     * Tests that Schnorr signature verification fails for wrong message.
     */
    @Test
    fun `schnorrVerify fails for wrong message`() =
        runTest {
            val adapter = MockCryptoAdapter()

            // Given: A signed message
            val keypair = adapter.generateKeypair()
            val originalMessage = adapter.sha256("Original message".encodeToByteArray())
            val signature = adapter.schnorrSign(keypair.privateKey, originalMessage)

            // When: Verifying with different message
            val differentMessage = adapter.sha256("Different message".encodeToByteArray())

            // Then: Verification should fail
            assertFalse(adapter.schnorrVerify(keypair.publicKey, differentMessage, signature))
        }

    /**
     * Tests that Schnorr signature verification fails for wrong public key.
     */
    @Test
    fun `schnorrVerify fails for wrong public key`() =
        runTest {
            val adapter = MockCryptoAdapter()

            // Given: A signed message
            val keypair1 = adapter.generateKeypair()
            val message = adapter.sha256("Test message".encodeToByteArray())
            val signature = adapter.schnorrSign(keypair1.privateKey, message)

            // When: Verifying with different public key
            val keypair2 = adapter.generateKeypair()

            // Then: Verification should fail
            assertFalse(adapter.schnorrVerify(keypair2.publicKey, message, signature))
        }
}

/**
 * Mock CryptoAdapter for testing purposes.
 *
 * Uses simple deterministic implementations to enable JVM testing.
 * Real Web Crypto API implementations will be tested in Phase 1
 * with JS-specific test infrastructure.
 */
private class MockCryptoAdapter : CryptoAdapter {
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
