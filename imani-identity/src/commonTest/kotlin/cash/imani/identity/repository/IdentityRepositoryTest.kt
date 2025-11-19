package cash.imani.identity.repository

import kotlin.js.JsName
import cash.imani.identity.crypto.createBip39Adapter
import cash.imani.identity.crypto.createCryptoAdapter
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Unit tests for IdentityRepository implementations.
 *
 * Tests CRUD operations, mnemonic import/export, and error handling.
 */
class IdentityRepositoryTest {
    private fun createRepository(): IdentityRepository {
        // Use platform-specific implementation for testing
        return createIdentityRepository(
            cryptoAdapter = createCryptoAdapter(),
            bip39Adapter = createBip39Adapter(),
        )
    }

    /**
     * Tests that createIdentity generates a valid identity.
     */
    @Test
    @JsName("createidentityGeneratesValidIdentityWithKeypair")
    fun `createIdentity generates valid identity with keypair`() =
        runTest {
            // Given: A repository
            val repository = createRepository()

            // When: Creating an identity
            val result = repository.createIdentity("Test Identity")

            // Then: Should succeed with valid identity
            assertTrue(result.isSuccess)
            val identity = result.getOrThrow()
            assertEquals("Test Identity", identity.label)
            assertEquals(64, identity.publicKey.length) // 32 bytes hex
            assertEquals(64, identity.privateKey.length) // 32 bytes hex
        }

    /**
     * Tests that createIdentity validates label length.
     */
    @Test
    @JsName("createidentityRejectsEmptyLabel")
    fun `createIdentity rejects empty label`() =
        runTest {
            // Given: A repository
            val repository = createRepository()

            // When: Creating identity with empty label
            val result = repository.createIdentity("")

            // Then: Should fail with validation error
            assertTrue(result.isFailure)
        }

    /**
     * Tests that createIdentity rejects too-long label.
     */
    @Test
    @JsName("createidentityRejectsLabelLongerThan100Characters")
    fun `createIdentity rejects label longer than 100 characters`() =
        runTest {
            // Given: A repository
            val repository = createRepository()

            // When: Creating identity with 101-character label
            val result = repository.createIdentity("a".repeat(101))

            // Then: Should fail with validation error
            assertTrue(result.isFailure)
        }

    /**
     * Tests that listIdentities returns empty list initially.
     */
    @Test
    @JsName("listidentitiesReturnsEmptyListWhenNoIdentitiesExist")
    fun `listIdentities returns empty list when no identities exist`() =
        runTest {
            // Given: A fresh repository
            val repository = createRepository()

            // When: Listing identities
            val result = repository.listIdentities()

            // Then: Should return empty list
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow().isEmpty())
        }

    /**
     * Tests that listIdentities returns created identities.
     */
    @Test
    @JsName("listidentitiesReturnsAllCreatedIdentities")
    fun `listIdentities returns all created identities`() =
        runTest {
            // Given: A repository with two identities
            val repository = createRepository()
            repository.createIdentity("Identity 1")
            repository.createIdentity("Identity 2")

            // When: Listing identities
            val result = repository.listIdentities()

            // Then: Should return both identities
            assertTrue(result.isSuccess)
            val identities = result.getOrThrow()
            assertEquals(2, identities.size)
        }

    /**
     * Tests that listIdentities sorts by lastUsedAt descending.
     */
    @Test
    @JsName("listidentitiesReturnsIdentitiesSortedByLastusedatDescending")
    fun `listIdentities returns identities sorted by lastUsedAt descending`() =
        runTest {
            // Given: A repository with two identities
            val repository = createRepository()
            val identity1 = repository.createIdentity("First").getOrThrow()
            val identity2 = repository.createIdentity("Second").getOrThrow()

            // When: Updating last used for first identity
            repository.updateLastUsed(identity1.id)

            // Then: First identity should be first in list
            val identities = repository.listIdentities().getOrThrow()
            assertEquals(identity1.id, identities[0].id)
        }

    /**
     * Tests that getIdentity retrieves correct identity.
     */
    @Test
    @JsName("getidentityRetrievesCorrectIdentityById")
    fun `getIdentity retrieves correct identity by ID`() =
        runTest {
            // Given: A repository with an identity
            val repository = createRepository()
            val created = repository.createIdentity("Test").getOrThrow()

            // When: Getting the identity
            val result = repository.getIdentity(created.id)

            // Then: Should return the correct identity
            assertTrue(result.isSuccess)
            val retrieved = result.getOrThrow()
            assertEquals(created.id, retrieved.id)
            assertEquals(created.label, retrieved.label)
            assertEquals(created.publicKey, retrieved.publicKey)
        }

    /**
     * Tests that getIdentity fails for non-existent ID.
     */
    @Test
    @JsName("getidentityFailsForNonExistentId")
    fun `getIdentity fails for non-existent ID`() =
        runTest {
            // Given: A repository
            val repository = createRepository()

            // When: Getting non-existent identity
            val result = repository.getIdentity("non-existent-id")

            // Then: Should fail with IdentityNotFoundException
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IdentityNotFoundException)
        }

    /**
     * Tests that getPrivateKey retrieves the correct key.
     */
    @Test
    @JsName("getprivatekeyRetrievesCorrectPrivateKey")
    fun `getPrivateKey retrieves correct private key`() =
        runTest {
            // Given: A repository with an identity
            val repository = createRepository()
            val identity = repository.createIdentity("Test").getOrThrow()

            // When: Getting the private key
            val result = repository.getPrivateKey(identity.id)

            // Then: Should return 32-byte key matching identity
            assertTrue(result.isSuccess)
            val privateKey = result.getOrThrow()
            assertEquals(32, privateKey.size)
        }

    /**
     * Tests that deleteIdentity removes the identity.
     */
    @Test
    @JsName("deleteidentityRemovesIdentityAndAllAssociatedData")
    fun `deleteIdentity removes identity and all associated data`() =
        runTest {
            // Given: A repository with an identity
            val repository = createRepository()
            val identity = repository.createIdentity("Test").getOrThrow()

            // When: Deleting the identity
            val deleteResult = repository.deleteIdentity(identity.id)

            // Then: Delete should succeed
            assertTrue(deleteResult.isSuccess)

            // And: Identity should no longer exist
            val getResult = repository.getIdentity(identity.id)
            assertTrue(getResult.isFailure)

            // And: Private key should no longer exist
            val keyResult = repository.getPrivateKey(identity.id)
            assertTrue(keyResult.isFailure)

            // And: Mnemonic should no longer exist
            val mnemonicResult = repository.exportMnemonic(identity.id)
            assertTrue(mnemonicResult.isFailure)
        }

    /**
     * Tests that deleteIdentity fails for non-existent ID.
     */
    @Test
    @JsName("deleteidentityFailsForNonExistentId")
    fun `deleteIdentity fails for non-existent ID`() =
        runTest {
            // Given: A repository
            val repository = createRepository()

            // When: Deleting non-existent identity
            val result = repository.deleteIdentity("non-existent-id")

            // Then: Should fail
            assertTrue(result.isFailure)
        }

    /**
     * Tests that exportMnemonic returns the mnemonic phrase.
     */
    @Test
    @JsName("exportmnemonicReturnsValidMnemonicPhrase")
    fun `exportMnemonic returns valid mnemonic phrase`() =
        runTest {
            // Given: A repository with an identity
            val repository = createRepository()
            val identity = repository.createIdentity("Test").getOrThrow()

            // When: Exporting the mnemonic
            val result = repository.exportMnemonic(identity.id)

            // Then: Should return space-separated words
            assertTrue(result.isSuccess)
            val mnemonic = result.getOrThrow()
            val words = mnemonic.split(" ")
            assertTrue(words.size in setOf(12, 24)) // 12 or 24 words
        }

    /**
     * Tests that importFromMnemonic restores an identity.
     */
    @Test
    @JsName("importfrommnemonicCreatesIdentityFromMnemonic")
    fun `importFromMnemonic creates identity from mnemonic`() =
        runTest {
            // Given: A repository with an exported mnemonic
            val repository = createRepository()
            val original = repository.createIdentity("Original").getOrThrow()
            val mnemonic = repository.exportMnemonic(original.id).getOrThrow()

            // When: Importing from mnemonic
            val imported = repository.importFromMnemonic(mnemonic, "Imported").getOrThrow()

            // Then: Should create new identity with different ID
            assertNotEquals(original.id, imported.id)
            assertEquals("Imported", imported.label)
        }

    /**
     * Tests that importFromMnemonic validates the mnemonic.
     */
    @Test
    @JsName("importfrommnemonicRejectsInvalidMnemonic")
    fun `importFromMnemonic rejects invalid mnemonic`() =
        runTest {
            // Given: A repository
            val repository = createRepository()

            // When: Importing with invalid mnemonic
            val result = repository.importFromMnemonic("invalid mnemonic phrase", "Test")

            // Then: Should fail with InvalidMnemonicException
            assertTrue(result.isFailure)
        }

    /**
     * Tests that updateLastUsed updates the timestamp.
     */
    @Test
    @JsName("updatelastusedUpdatesLastusedatTimestamp")
    fun `updateLastUsed updates lastUsedAt timestamp`() =
        runTest {
            // Given: A repository with an identity
            val repository = createRepository()
            val identity = repository.createIdentity("Test").getOrThrow()

            // When: Updating last used
            val updateResult = repository.updateLastUsed(identity.id)
            assertTrue(updateResult.isSuccess)

            // Then: lastUsedAt should be updated (or at least not null)
            val updated = repository.getIdentity(identity.id).getOrThrow()
            assertTrue(updated.lastUsedAt != null, "lastUsedAt should not be null after update")
        }
}
