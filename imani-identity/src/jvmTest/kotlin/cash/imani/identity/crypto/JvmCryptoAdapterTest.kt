package cash.imani.identity.crypto

import cash.imani.identity.util.toHex
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Unit tests for JvmCryptoAdapter.
 *
 * Tests the JVM implementation of CryptoAdapter which provides:
 * - Random number generation via SecureRandom
 * - SHA-256 hashing via MessageDigest
 * - Basic keypair generation (placeholder implementation)
 * - Verification that unimplemented methods throw NotImplementedError
 *
 * Phase 1 Status: Tests basic functionality and error handling.
 * Phase 2 TODO: Add tests for BouncyCastle-based Schnorr signatures and NIP-44 encryption.
 */
class JvmCryptoAdapterTest {
    private val adapter = JvmCryptoAdapter()

    // ==================== Random Number Generation Tests ====================

    /**
     * Tests that generateRandomBytes returns the correct number of bytes.
     */
    @Test
    fun `generateRandomBytes returns correct length`() =
        runTest {
            // When: Generating bytes of various lengths
            val bytes8 = adapter.generateRandomBytes(8)
            val bytes16 = adapter.generateRandomBytes(16)
            val bytes32 = adapter.generateRandomBytes(32)
            val bytes64 = adapter.generateRandomBytes(64)

            // Then: Should return exact lengths
            assertEquals(8, bytes8.size)
            assertEquals(16, bytes16.size)
            assertEquals(32, bytes32.size)
            assertEquals(64, bytes64.size)
        }

    /**
     * Tests that generateRandomBytes produces non-deterministic output.
     */
    @Test
    fun `generateRandomBytes produces different values on successive calls`() =
        runTest {
            // Given: Multiple calls to generate random bytes
            val bytes1 = adapter.generateRandomBytes(32)
            val bytes2 = adapter.generateRandomBytes(32)
            val bytes3 = adapter.generateRandomBytes(32)

            // Then: Should produce different values (with very high probability)
            // Testing with multiple comparisons to ensure randomness
            assertNotEquals(bytes1.toHex(), bytes2.toHex(), "bytes1 should differ from bytes2")
            assertNotEquals(bytes2.toHex(), bytes3.toHex(), "bytes2 should differ from bytes3")
            assertNotEquals(bytes1.toHex(), bytes3.toHex(), "bytes1 should differ from bytes3")
        }

    /**
     * Tests that generateRandomBytes produces non-zero bytes.
     * While it's theoretically possible to get all zeros from SecureRandom,
     * the probability is astronomically low (2^-256 for 32 bytes).
     */
    @Test
    fun `generateRandomBytes produces non-zero bytes`() =
        runTest {
            // When: Generating random bytes
            val bytes = adapter.generateRandomBytes(32)

            // Then: At least some bytes should be non-zero
            // (Testing that we didn't get an all-zero array)
            val hasNonZero = bytes.any { it != 0.toByte() }
            assertTrue(hasNonZero, "Random bytes should contain at least one non-zero byte")
        }

    /**
     * Tests that generateRandomBytes handles edge case of length 1.
     */
    @Test
    fun `generateRandomBytes handles length 1`() =
        runTest {
            // When: Generating a single byte
            val bytes = adapter.generateRandomBytes(1)

            // Then: Should return exactly 1 byte
            assertEquals(1, bytes.size)
        }

    // ==================== SHA-256 Hashing Tests ====================

    /**
     * Tests that SHA-256 produces consistent 32-byte hashes.
     */
    @Test
    fun `sha256 produces consistent 32-byte hash`() =
        runTest {
            // Given: Same input data
            val data = "Hello, Imani Wallet!".encodeToByteArray()

            // When: Hashing twice
            val hash1 = adapter.sha256(data)
            val hash2 = adapter.sha256(data)

            // Then: Hashes should be identical and 32 bytes
            assertEquals(32, hash1.size)
            assertEquals(32, hash2.size)
            assertEquals(hash1.toHex(), hash2.toHex())
        }

    /**
     * Tests that SHA-256 produces different hashes for different inputs.
     */
    @Test
    fun `sha256 produces different hashes for different inputs`() =
        runTest {
            // Given: Three different messages
            val data1 = "Message 1".encodeToByteArray()
            val data2 = "Message 2".encodeToByteArray()
            val data3 = "Message 3".encodeToByteArray()

            // When: Hashing all three
            val hash1 = adapter.sha256(data1)
            val hash2 = adapter.sha256(data2)
            val hash3 = adapter.sha256(data3)

            // Then: All hashes should differ
            assertNotEquals(hash1.toHex(), hash2.toHex(), "hash1 should differ from hash2")
            assertNotEquals(hash2.toHex(), hash3.toHex(), "hash2 should differ from hash3")
            assertNotEquals(hash1.toHex(), hash3.toHex(), "hash1 should differ from hash3")
        }

    /**
     * Tests that SHA-256 matches known test vectors.
     * Using SHA-256 test vector from NIST for "abc".
     */
    @Test
    fun `sha256 matches known test vector`() =
        runTest {
            // Given: Known test vector "abc"
            val data = "abc".encodeToByteArray()
            val expectedHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

            // When: Hashing the data
            val hash = adapter.sha256(data)

            // Then: Should match the known SHA-256 hash
            assertEquals(expectedHash, hash.toHex())
        }

    /**
     * Tests that SHA-256 handles empty input.
     */
    @Test
    fun `sha256 handles empty input`() =
        runTest {
            // Given: Empty byte array
            val emptyData = ByteArray(0)
            val expectedHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

            // When: Hashing empty data
            val hash = adapter.sha256(emptyData)

            // Then: Should produce the known hash for empty input
            assertEquals(32, hash.size)
            assertEquals(expectedHash, hash.toHex())
        }

    /**
     * Tests that SHA-256 handles large inputs.
     */
    @Test
    fun `sha256 handles large input`() =
        runTest {
            // Given: Large input (1MB)
            val largeData = ByteArray(1024 * 1024) { it.toByte() }

            // When: Hashing large data
            val hash = adapter.sha256(largeData)

            // Then: Should produce a 32-byte hash
            assertEquals(32, hash.size)
        }

    // ==================== Keypair Generation Tests ====================

    /**
     * Tests that generateKeypair produces 32-byte keys.
     * In Phase 1, this is a placeholder implementation.
     */
    @Test
    fun `generateKeypair produces 32-byte keys`() =
        runTest {
            // When: Generating a keypair
            val keypair = adapter.generateKeypair()

            // Then: Both keys should be 32 bytes (Nostr standard)
            assertEquals(32, keypair.publicKey.size, "Public key should be 32 bytes")
            assertEquals(32, keypair.privateKey.size, "Private key should be 32 bytes")
        }

    /**
     * Tests that successive keypair generations produce different keys.
     */
    @Test
    fun `generateKeypair produces unique keys`() =
        runTest {
            // When: Generating three keypairs
            val keypair1 = adapter.generateKeypair()
            val keypair2 = adapter.generateKeypair()
            val keypair3 = adapter.generateKeypair()

            // Then: All keys should be different
            assertNotEquals(
                keypair1.publicKey.toHex(),
                keypair2.publicKey.toHex(),
                "keypair1 pubkey should differ from keypair2",
            )
            assertNotEquals(
                keypair2.publicKey.toHex(),
                keypair3.publicKey.toHex(),
                "keypair2 pubkey should differ from keypair3",
            )
            assertNotEquals(
                keypair1.privateKey.toHex(),
                keypair2.privateKey.toHex(),
                "keypair1 privkey should differ from keypair2",
            )
            assertNotEquals(
                keypair2.privateKey.toHex(),
                keypair3.privateKey.toHex(),
                "keypair2 privkey should differ from keypair3",
            )
        }

    /**
     * Tests that public and private keys in a keypair are different.
     */
    @Test
    fun `generateKeypair produces different public and private keys`() =
        runTest {
            // When: Generating a keypair
            val keypair = adapter.generateKeypair()

            // Then: Public and private keys should be different
            // (This is a basic sanity check for the placeholder implementation)
            assertNotEquals(
                keypair.publicKey.toHex(),
                keypair.privateKey.toHex(),
                "Public and private keys should be different",
            )
        }

    // ==================== Unimplemented Method Tests ====================

    /**
     * Tests that getPublicKey throws NotImplementedError.
     * Phase 1 Status: Not yet implemented for JVM.
     */
    @Test
    fun `getPublicKey throws NotImplementedError`() =
        runTest {
            // Given: A 32-byte private key
            val privateKey = ByteArray(32) { it.toByte() }

            // When/Then: Calling getPublicKey should throw NotImplementedError
            val exception =
                assertFailsWith<NotImplementedError> {
                    adapter.getPublicKey(privateKey)
                }

            // Then: Exception message should indicate JVM not implemented
            assertTrue(
                exception.message?.contains("not yet implemented for JVM") == true,
                "Exception message should mention JVM not implemented",
            )
        }

    /**
     * Tests that schnorrSign throws NotImplementedError.
     * Phase 1 Status: Not yet implemented for JVM.
     */
    @Test
    fun `schnorrSign throws NotImplementedError`() =
        runTest {
            // Given: A private key and message
            val privateKey = ByteArray(32) { it.toByte() }
            val message = ByteArray(32) { (it + 100).toByte() }

            // When/Then: Calling schnorrSign should throw NotImplementedError
            val exception =
                assertFailsWith<NotImplementedError> {
                    adapter.schnorrSign(privateKey, message)
                }

            // Then: Exception message should indicate Schnorr not implemented
            assertTrue(
                exception.message?.contains("Schnorr signatures not yet implemented") == true,
                "Exception message should mention Schnorr not implemented",
            )
        }

    /**
     * Tests that schnorrVerify throws NotImplementedError.
     * Phase 1 Status: Not yet implemented for JVM.
     */
    @Test
    fun `schnorrVerify throws NotImplementedError`() =
        runTest {
            // Given: A public key, message, and signature
            val publicKey = ByteArray(32) { it.toByte() }
            val message = ByteArray(32) { (it + 100).toByte() }
            val signature = ByteArray(64) { (it + 200).toByte() }

            // When/Then: Calling schnorrVerify should throw NotImplementedError
            val exception =
                assertFailsWith<NotImplementedError> {
                    adapter.schnorrVerify(publicKey, message, signature)
                }

            // Then: Exception message should indicate Schnorr not implemented
            assertTrue(
                exception.message?.contains("Schnorr verification not yet implemented") == true,
                "Exception message should mention Schnorr verification not implemented",
            )
        }

    /**
     * Tests that encryptNip44 throws NotImplementedError.
     * Phase 1 Status: Not yet implemented for JVM.
     */
    @Test
    fun `encryptNip44 throws NotImplementedError`() =
        runTest {
            // Given: Plaintext and keys
            val plaintext = "Hello, Imani!"
            val recipientPubkey = "0".repeat(64)
            val senderPrivkey = "1".repeat(64)

            // When/Then: Calling encryptNip44 should throw NotImplementedError
            val exception =
                assertFailsWith<NotImplementedError> {
                    adapter.encryptNip44(plaintext, recipientPubkey, senderPrivkey)
                }

            // Then: Exception message should indicate NIP-44 not implemented
            assertTrue(
                exception.message?.contains("NIP-44 encryption not yet implemented") == true,
                "Exception message should mention NIP-44 encryption not implemented",
            )
        }

    /**
     * Tests that decryptNip44 throws NotImplementedError.
     * Phase 1 Status: Not yet implemented for JVM.
     */
    @Test
    fun `decryptNip44 throws NotImplementedError`() =
        runTest {
            // Given: Ciphertext and keys
            val ciphertext = "encrypted_data"
            val senderPubkey = "0".repeat(64)
            val recipientPrivkey = "1".repeat(64)

            // When/Then: Calling decryptNip44 should throw NotImplementedError
            val exception =
                assertFailsWith<NotImplementedError> {
                    adapter.decryptNip44(ciphertext, senderPubkey, recipientPrivkey)
                }

            // Then: Exception message should indicate NIP-44 not implemented
            assertTrue(
                exception.message?.contains("NIP-44 decryption not yet implemented") == true,
                "Exception message should mention NIP-44 decryption not implemented",
            )
        }

    // ==================== Edge Case Tests ====================

    /**
     * Tests that SHA-256 handles binary data (not just text).
     */
    @Test
    fun `sha256 handles binary data`() =
        runTest {
            // Given: Binary data with all byte values
            val binaryData = ByteArray(256) { it.toByte() }

            // When: Hashing binary data
            val hash = adapter.sha256(binaryData)

            // Then: Should produce a valid 32-byte hash
            assertEquals(32, hash.size)
            // Hash should be deterministic
            val hash2 = adapter.sha256(binaryData)
            assertEquals(hash.toHex(), hash2.toHex())
        }

    /**
     * Tests that generateRandomBytes can generate very small arrays.
     */
    @Test
    fun `generateRandomBytes handles very small length`() =
        runTest {
            // When: Generating very small byte arrays
            val bytes1 = adapter.generateRandomBytes(1)
            val bytes2 = adapter.generateRandomBytes(2)

            // Then: Should return correct sizes
            assertEquals(1, bytes1.size)
            assertEquals(2, bytes2.size)
        }

    /**
     * Tests that generateRandomBytes can generate large arrays.
     */
    @Test
    fun `generateRandomBytes handles large length`() =
        runTest {
            // When: Generating a large byte array (1KB)
            val bytes = adapter.generateRandomBytes(1024)

            // Then: Should return correct size and have non-zero bytes
            assertEquals(1024, bytes.size)
            val hasNonZero = bytes.any { it != 0.toByte() }
            assertTrue(hasNonZero, "Large random array should contain non-zero bytes")
        }
}
