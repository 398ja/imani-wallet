package cash.imani.android.security

import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for KeystoreManager using Robolectric.
 *
 * Tests Android Keystore encryption/decryption of private keys.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28]) // Android 9.0 (API 28)
class KeystoreManagerTest {

    private lateinit var keystoreManager: KeystoreManager

    @Before
    fun setup() {
        keystoreManager = KeystoreManager()
    }

    @After
    fun cleanup() {
        // Clean up test keys
        try {
            keystoreManager.deleteKey(TEST_ALIAS)
            keystoreManager.deleteKey(TEST_ALIAS_2)
        } catch (e: Exception) {
            // Ignore cleanup errors
        }
    }

    /**
     * Tests that private keys can be encrypted and decrypted successfully.
     */
    @Test
    fun `encryptPrivateKey and decryptPrivateKey roundtrip succeeds`() {
        // Given: A 32-byte private key
        val privateKey = ByteArray(32) { it.toByte() }

        // When: Encrypt and decrypt
        val encrypted = keystoreManager.encryptPrivateKey(privateKey, TEST_ALIAS)
        val decrypted = keystoreManager.decryptPrivateKey(encrypted, TEST_ALIAS)

        // Then: Decrypted matches original
        assertContentEquals(privateKey, decrypted)
    }

    /**
     * Tests that encrypted data includes IV (first 12 bytes).
     */
    @Test
    fun `encryptPrivateKey prepends IV to ciphertext`() {
        // Given: A 32-byte private key
        val privateKey = ByteArray(32) { it.toByte() }

        // When: Encrypt
        val encrypted = keystoreManager.encryptPrivateKey(privateKey, TEST_ALIAS)

        // Then: Encrypted data is longer than input (IV + ciphertext + GCM tag)
        // Expected: 12 bytes (IV) + 32 bytes (data) + 16 bytes (GCM tag) = 60 bytes
        assertTrue(encrypted.size >= 44, "Encrypted data should be at least 44 bytes (IV + data), got ${encrypted.size}")
    }

    /**
     * Tests that encryption with different aliases produces different ciphertexts.
     */
    @Test
    fun `encryptPrivateKey with different aliases produces different ciphertexts`() {
        // Given: Same private key, different aliases
        val privateKey = ByteArray(32) { it.toByte() }

        // When: Encrypt with two different aliases
        val encrypted1 = keystoreManager.encryptPrivateKey(privateKey, TEST_ALIAS)
        val encrypted2 = keystoreManager.encryptPrivateKey(privateKey, TEST_ALIAS_2)

        // Then: Ciphertexts are different (different keys used)
        assertFalse(encrypted1.contentEquals(encrypted2))

        // But decryption works correctly for both
        val decrypted1 = keystoreManager.decryptPrivateKey(encrypted1, TEST_ALIAS)
        val decrypted2 = keystoreManager.decryptPrivateKey(encrypted2, TEST_ALIAS_2)
        assertContentEquals(privateKey, decrypted1)
        assertContentEquals(privateKey, decrypted2)
    }

    /**
     * Tests that encryption fails if private key is not 32 bytes.
     */
    @Test
    fun `encryptPrivateKey throws if privateKey is not 32 bytes`() {
        // Given: Invalid private key sizes
        val tooShort = ByteArray(31)
        val tooLong = ByteArray(33)

        // When/Then: Encryption fails
        assertFailsWith<IllegalArgumentException> {
            keystoreManager.encryptPrivateKey(tooShort, TEST_ALIAS)
        }

        assertFailsWith<IllegalArgumentException> {
            keystoreManager.encryptPrivateKey(tooLong, TEST_ALIAS)
        }
    }

    /**
     * Tests that decryption fails if encrypted data is too short.
     */
    @Test
    fun `decryptPrivateKey throws if encryptedData is too short`() {
        // Given: Data shorter than IV size (12 bytes)
        val tooShort = ByteArray(11)

        // When/Then: Decryption fails
        assertFailsWith<IllegalArgumentException> {
            keystoreManager.decryptPrivateKey(tooShort, TEST_ALIAS)
        }
    }

    /**
     * Tests that hasKey returns true after key creation.
     */
    @Test
    fun `hasKey returns true after encryptPrivateKey`() {
        // Given: No key exists initially
        assertFalse(keystoreManager.hasKey(TEST_ALIAS))

        // When: Encrypt (which creates the key)
        val privateKey = ByteArray(32) { it.toByte() }
        keystoreManager.encryptPrivateKey(privateKey, TEST_ALIAS)

        // Then: hasKey returns true
        assertTrue(keystoreManager.hasKey(TEST_ALIAS))
    }

    /**
     * Tests that deleteKey removes the key from keystore.
     */
    @Test
    fun `deleteKey removes key from keystore`() {
        // Given: A key exists
        val privateKey = ByteArray(32) { it.toByte() }
        keystoreManager.encryptPrivateKey(privateKey, TEST_ALIAS)
        assertTrue(keystoreManager.hasKey(TEST_ALIAS))

        // When: Delete the key
        keystoreManager.deleteKey(TEST_ALIAS)

        // Then: Key no longer exists
        assertFalse(keystoreManager.hasKey(TEST_ALIAS))
    }

    /**
     * Tests that the same key is reused for the same alias.
     */
    @Test
    fun `same alias reuses existing keystore key`() {
        // Given: Encrypt once
        val privateKey1 = ByteArray(32) { 1 }
        val encrypted1 = keystoreManager.encryptPrivateKey(privateKey1, TEST_ALIAS)

        // When: Encrypt again with same alias (different data)
        val privateKey2 = ByteArray(32) { 2 }
        val encrypted2 = keystoreManager.encryptPrivateKey(privateKey2, TEST_ALIAS)

        // Then: Both can be decrypted correctly (same key was used)
        val decrypted1 = keystoreManager.decryptPrivateKey(encrypted1, TEST_ALIAS)
        val decrypted2 = keystoreManager.decryptPrivateKey(encrypted2, TEST_ALIAS)

        assertContentEquals(privateKey1, decrypted1)
        assertContentEquals(privateKey2, decrypted2)
    }

    /**
     * Tests encryption/decryption with real secp256k1-like random bytes.
     */
    @Test
    fun `encryptPrivateKey handles random bytes correctly`() {
        // Given: Random 32-byte key (simulating real private key)
        val random = java.security.SecureRandom()
        val privateKey = ByteArray(32)
        random.nextBytes(privateKey)

        // When: Encrypt and decrypt
        val encrypted = keystoreManager.encryptPrivateKey(privateKey, TEST_ALIAS)
        val decrypted = keystoreManager.decryptPrivateKey(encrypted, TEST_ALIAS)

        // Then: Roundtrip succeeds
        assertContentEquals(privateKey, decrypted)
    }

    /**
     * Tests that decryption with wrong alias fails.
     */
    @Test
    fun `decryptPrivateKey with wrong alias fails`() {
        // Given: Encrypted with one alias
        val privateKey = ByteArray(32) { it.toByte() }
        val encrypted = keystoreManager.encryptPrivateKey(privateKey, TEST_ALIAS)

        // When/Then: Decrypt with different alias fails (key not found)
        assertFailsWith<Exception> {
            keystoreManager.decryptPrivateKey(encrypted, "wrong_alias")
        }
    }

    companion object {
        private const val TEST_ALIAS = "test_identity_key"
        private const val TEST_ALIAS_2 = "test_identity_key_2"
    }
}
