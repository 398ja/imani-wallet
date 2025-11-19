package cash.imani.android.identity

import cash.imani.android.security.KeystoreManager
import cash.imani.identity.domain.Identity
import cash.imani.identity.util.toHex
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.datetime.Clock
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for AndroidIdentityManager using Robolectric and MockK.
 *
 * Tests the Android wrapper for identity management with Keystore integration.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class AndroidIdentityManagerTest {

    private lateinit var keystoreManager: KeystoreManager
    private lateinit var manager: AndroidIdentityManager

    @Before
    fun setup() {
        keystoreManager = mockk(relaxed = true)
        manager = AndroidIdentityManager(keystoreManager)
    }

    /**
     * Tests that encryptPrivateKey delegates to KeystoreManager correctly.
     */
    @Test
    fun `encryptPrivateKey calls KeystoreManager with correct parameters`() {
        // Given: An identity with a private key
        val identity = createTestIdentity()
        val expectedAlias = "identity_${identity.id}"
        val expectedEncrypted = ByteArray(60) { it.toByte() } // Simulated encrypted data

        every {
            keystoreManager.encryptPrivateKey(any(), expectedAlias)
        } returns expectedEncrypted

        // When: Encrypt private key
        val encrypted = manager.encryptPrivateKey(identity)

        // Then: KeystoreManager called with correct alias
        verify {
            keystoreManager.encryptPrivateKey(
                match { it.size == 32 }, // 32-byte private key
                expectedAlias
            )
        }

        // And: Returns encrypted data
        assertContentEquals(expectedEncrypted, encrypted)
    }

    /**
     * Tests that decryptPrivateKey delegates to KeystoreManager correctly.
     */
    @Test
    fun `decryptPrivateKey calls KeystoreManager and returns hex string`() {
        // Given: Encrypted private key
        val identityId = "test-id-123"
        val encryptedData = ByteArray(60) { it.toByte() }
        val decryptedBytes = ByteArray(32) { (it + 1).toByte() }
        val expectedAlias = "identity_$identityId"

        every {
            keystoreManager.decryptPrivateKey(encryptedData, expectedAlias)
        } returns decryptedBytes

        // When: Decrypt private key
        val decryptedHex = manager.decryptPrivateKey(identityId, encryptedData)

        // Then: Returns hex string
        assertEquals(decryptedBytes.toHex(), decryptedHex)
        assertEquals(64, decryptedHex.length) // 32 bytes = 64 hex chars
    }

    /**
     * Tests that deletePrivateKey delegates to KeystoreManager.
     */
    @Test
    fun `deletePrivateKey calls KeystoreManager with correct alias`() {
        // Given: An identity ID
        val identityId = "test-id-456"
        val expectedAlias = "identity_$identityId"

        // When: Delete private key
        manager.deletePrivateKey(identityId)

        // Then: KeystoreManager deleteKey called
        verify {
            keystoreManager.deleteKey(expectedAlias)
        }
    }

    /**
     * Tests that hasPrivateKey delegates to KeystoreManager.
     */
    @Test
    fun `hasPrivateKey delegates to KeystoreManager`() {
        // Given: An identity ID
        val identityId = "test-id-789"
        val expectedAlias = "identity_$identityId"

        every { keystoreManager.hasKey(expectedAlias) } returns true

        // When: Check if key exists
        val exists = manager.hasPrivateKey(identityId)

        // Then: Returns true
        assertTrue(exists)
        verify { keystoreManager.hasKey(expectedAlias) }
    }

    /**
     * Tests that prepareForStorage encrypts and clears private key from memory.
     */
    @Test
    fun `prepareForStorage encrypts private key and clears it from identity`() {
        // Given: An identity
        val identity = createTestIdentity()
        val encryptedData = ByteArray(60) { it.toByte() }

        every {
            keystoreManager.encryptPrivateKey(any(), any())
        } returns encryptedData

        // When: Prepare for storage
        val (secureIdentity, encrypted) = manager.prepareForStorage(identity)

        // Then: Private key cleared from identity
        assertEquals("", secureIdentity.privateKey)

        // And: Other fields preserved
        assertEquals(identity.id, secureIdentity.id)
        assertEquals(identity.label, secureIdentity.label)
        assertEquals(identity.publicKey, secureIdentity.publicKey)

        // And: Encrypted data returned
        assertContentEquals(encryptedData, encrypted)
    }

    /**
     * Tests that markAsUsed updates the timestamp.
     */
    @Test
    fun `markAsUsed updates lastUsedAt timestamp`() {
        // Given: An identity
        val identity = createTestIdentity()
        val before = Clock.System.now()

        // When: Mark as used
        val updated = manager.markAsUsed(identity)

        // Then: lastUsedAt is updated
        assertTrue(updated.lastUsedAt!! >= before)
    }

    /**
     * Tests validatePrivateKeyHex with valid key.
     */
    @Test
    fun `validatePrivateKeyHex succeeds with 64 hex characters`() {
        // Given: Valid private key hex (64 chars)
        val validHex = "a".repeat(64)

        // When/Then: No exception thrown
        AndroidIdentityManager.validatePrivateKeyHex(validHex)
    }

    /**
     * Tests validatePrivateKeyHex with invalid key length.
     */
    @Test
    fun `validatePrivateKeyHex throws with invalid length`() {
        // Given: Invalid private key hex (63 chars)
        val invalidHex = "a".repeat(63)

        // When/Then: Exception thrown
        val exception = kotlin.test.assertFailsWith<IllegalArgumentException> {
            AndroidIdentityManager.validatePrivateKeyHex(invalidHex)
        }

        assertTrue(exception.message!!.contains("64 hex characters"))
    }

    /**
     * Tests that encryption roundtrip works with real KeystoreManager.
     */
    @Test
    fun `encryption roundtrip works with real KeystoreManager`() {
        // Given: Real KeystoreManager and identity
        val realKeystoreManager = KeystoreManager()
        val realManager = AndroidIdentityManager(realKeystoreManager)
        val identity = createTestIdentity()

        try {
            // When: Encrypt
            val encrypted = realManager.encryptPrivateKey(identity)

            // And: Decrypt
            val decryptedHex = realManager.decryptPrivateKey(identity.id, encrypted)

            // Then: Matches original
            assertEquals(identity.privateKey, decryptedHex)
        } finally {
            // Cleanup
            realKeystoreManager.deleteKey("identity_${identity.id}")
        }
    }

    /**
     * Creates a test identity with deterministic values.
     */
    private fun createTestIdentity(): Identity {
        val now = Clock.System.now()
        return Identity(
            id = "test-identity-123",
            label = "Test Identity",
            publicKey = "0".repeat(64), // 32 bytes hex
            privateKey = "1".repeat(64), // 32 bytes hex
            createdAt = now,
            lastUsedAt = now
        )
    }
}
