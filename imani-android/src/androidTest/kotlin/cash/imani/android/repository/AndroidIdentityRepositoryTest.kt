package cash.imani.android.repository

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import cash.imani.android.db.ImaniDatabase
import cash.imani.android.security.AndroidIdentityManager
import cash.imani.identity.domain.Identity
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

/**
 * Unit tests for AndroidIdentityRepository.
 *
 * Tests database operations, encryption, and reactive queries.
 * Uses AndroidJUnit4 with real SQLDelight database.
 */
@RunWith(AndroidJUnit4::class)
class AndroidIdentityRepositoryTest {

    private lateinit var context: Context
    private lateinit var database: ImaniDatabase
    private lateinit var identityManager: AndroidIdentityManager
    private lateinit var repository: AndroidIdentityRepository

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()

        // Create in-memory database for testing
        val driver = AndroidSqliteDriver(
            schema = ImaniDatabase.Schema,
            context = context,
            name = null // null = in-memory
        )
        database = ImaniDatabase(driver)

        identityManager = AndroidIdentityManager(context)
        repository = AndroidIdentityRepository(database, identityManager)
    }

    @After
    fun teardown() {
        database.close()
    }

    /**
     * Tests that saveIdentity stores identity with encrypted private key.
     */
    @Test
    fun saveIdentity_storesIdentityWithEncryptedPrivateKey() = runTest {
        // Given: A sample identity
        val identity = createSampleIdentity(
            id = "test-id-1",
            label = "Test Identity",
            privateKey = "0".repeat(64)
        )

        // When: Saving the identity
        val result = repository.saveIdentity(identity)

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify stored in database (encrypted)
        val storedEntity = database.identityQueries.selectById("test-id-1").executeAsOne()
        assertEquals("test-id-1", storedEntity.id)
        assertEquals("Test Identity", storedEntity.label)
        assertNotNull(storedEntity.encryptedPrivateKey)
        assertTrue(storedEntity.encryptedPrivateKey.isNotEmpty())
    }

    /**
     * Tests that listIdentities returns all identities with decrypted private keys.
     */
    @Test
    fun listIdentities_returnsAllIdentitiesWithDecryptedKeys() = runTest {
        // Given: Multiple identities saved
        val identity1 = createSampleIdentity("id-1", "Identity 1", "1".repeat(64))
        val identity2 = createSampleIdentity("id-2", "Identity 2", "2".repeat(64))
        repository.saveIdentity(identity1)
        repository.saveIdentity(identity2)

        // When: Listing identities
        val result = repository.listIdentities()

        // Then: Should return both identities with decrypted keys
        assertTrue(result.isSuccess)
        val identities = result.getOrThrow()
        assertEquals(2, identities.size)

        val retrieved1 = identities.find { it.id == "id-1" }!!
        assertEquals("Identity 1", retrieved1.label)
        assertEquals("1".repeat(64), retrieved1.privateKey)

        val retrieved2 = identities.find { it.id == "id-2" }!!
        assertEquals("Identity 2", retrieved2.label)
        assertEquals("2".repeat(64), retrieved2.privateKey)
    }

    /**
     * Tests that listIdentities returns empty list when no identities exist.
     */
    @Test
    fun listIdentities_returnsEmptyListWhenNoIdentities() = runTest {
        // Given: Empty database

        // When: Listing identities
        val result = repository.listIdentities()

        // Then: Should return empty list
        assertTrue(result.isSuccess)
        assertTrue(result.getOrThrow().isEmpty())
    }

    /**
     * Tests that getIdentity retrieves specific identity by ID.
     */
    @Test
    fun getIdentity_retrievesIdentityById() = runTest {
        // Given: Multiple identities saved
        val identity1 = createSampleIdentity("id-1", "Identity 1", "1".repeat(64))
        val identity2 = createSampleIdentity("id-2", "Identity 2", "2".repeat(64))
        repository.saveIdentity(identity1)
        repository.saveIdentity(identity2)

        // When: Getting specific identity
        val result = repository.getIdentity("id-1")

        // Then: Should return correct identity
        assertTrue(result.isSuccess)
        val retrieved = result.getOrThrow()
        assertEquals("id-1", retrieved.id)
        assertEquals("Identity 1", retrieved.label)
        assertEquals("1".repeat(64), retrieved.privateKey)
    }

    /**
     * Tests that getIdentity returns failure for non-existent ID.
     */
    @Test
    fun getIdentity_returnsFailureForNonExistentId() = runTest {
        // Given: Empty database

        // When: Getting non-existent identity
        val result = repository.getIdentity("non-existent")

        // Then: Should fail
        assertTrue(result.isFailure)
    }

    /**
     * Tests that updateIdentity updates existing identity.
     */
    @Test
    fun updateIdentity_updatesExistingIdentity() = runTest {
        // Given: An identity saved
        val identity = createSampleIdentity("id-1", "Original Label", "1".repeat(64))
        repository.saveIdentity(identity)

        // When: Updating the identity
        val updated = identity.copy(label = "Updated Label")
        val result = repository.updateIdentity(updated)

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify updated
        val retrieved = repository.getIdentity("id-1").getOrThrow()
        assertEquals("Updated Label", retrieved.label)
    }

    /**
     * Tests that deleteIdentity removes identity from database.
     */
    @Test
    fun deleteIdentity_removesIdentity() = runTest {
        // Given: An identity saved
        val identity = createSampleIdentity("id-1", "Test", "1".repeat(64))
        repository.saveIdentity(identity)

        // When: Deleting the identity
        val result = repository.deleteIdentity("id-1")

        // Then: Should succeed
        assertTrue(result.isSuccess)

        // Verify removed
        val list = repository.listIdentities().getOrThrow()
        assertTrue(list.none { it.id == "id-1" })
    }

    /**
     * Tests that observeIdentities returns reactive Flow.
     */
    @Test
    fun observeIdentities_returnsReactiveFlow() = runTest {
        // Given: Initial identity saved
        val identity = createSampleIdentity("id-1", "Test", "1".repeat(64))
        repository.saveIdentity(identity)

        // When: Observing identities
        val flow = repository.observeIdentities()

        // Then: Flow should emit current list
        flow.collect { identities ->
            assertEquals(1, identities.size)
            assertEquals("id-1", identities[0].id)
            return@collect // Exit after first emission
        }
    }

    /**
     * Tests that identities are sorted by lastUsedAt descending.
     */
    @Test
    fun listIdentities_sortsByLastUsedAtDescending() = runTest {
        // Given: Multiple identities with different lastUsedAt
        val now = Clock.System.now()
        val identity1 = createSampleIdentity("id-1", "Old", "1".repeat(64))
            .copy(lastUsedAt = now.minus(30.days))
        val identity2 = createSampleIdentity("id-2", "Recent", "2".repeat(64))
            .copy(lastUsedAt = now.minus(1.days))
        val identity3 = createSampleIdentity("id-3", "Never", "3".repeat(64))
            .copy(lastUsedAt = null)

        repository.saveIdentity(identity1)
        repository.saveIdentity(identity2)
        repository.saveIdentity(identity3)

        // When: Listing identities
        val identities = repository.listIdentities().getOrThrow()

        // Then: Should be sorted by lastUsedAt descending (nulls last in SQLite)
        assertEquals("id-2", identities[0].id) // Most recent
        assertEquals("id-1", identities[1].id)
        assertEquals("id-3", identities[2].id) // null lastUsedAt
    }

    /**
     * Tests that saving identity with same ID replaces existing (INSERT OR REPLACE).
     */
    @Test
    fun saveIdentity_replacesExistingIdentityWithSameId() = runTest {
        // Given: An identity saved
        val identity1 = createSampleIdentity("id-1", "Original", "1".repeat(64))
        repository.saveIdentity(identity1)

        // When: Saving another identity with same ID
        val identity2 = createSampleIdentity("id-1", "Replacement", "2".repeat(64))
        val result = repository.saveIdentity(identity2)

        // Then: Should succeed and replace
        assertTrue(result.isSuccess)

        val identities = repository.listIdentities().getOrThrow()
        assertEquals(1, identities.size)
        assertEquals("Replacement", identities[0].label)
        assertEquals("2".repeat(64), identities[0].privateKey)
    }

    /**
     * Tests that private key encryption/decryption roundtrip works.
     */
    @Test
    fun encryption_roundtrip_preservesPrivateKey() = runTest {
        // Given: An identity with specific private key
        val originalPrivateKey = "abcdef0123456789".repeat(4) // 64 chars
        val identity = createSampleIdentity("id-1", "Test", originalPrivateKey)

        // When: Saving and retrieving
        repository.saveIdentity(identity)
        val retrieved = repository.getIdentity("id-1").getOrThrow()

        // Then: Private key should match original
        assertEquals(originalPrivateKey, retrieved.privateKey)
    }

    /**
     * Tests that createIdentity throws UnsupportedOperationException.
     */
    @Test
    fun createIdentity_throwsUnsupportedOperationException() = runTest {
        // Given: Repository

        // When/Then: Should throw
        val result = repository.createIdentity("Test")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is UnsupportedOperationException)
    }

    /**
     * Tests that importFromMnemonic throws UnsupportedOperationException.
     */
    @Test
    fun importFromMnemonic_throwsUnsupportedOperationException() = runTest {
        // Given: Repository

        // When/Then: Should throw
        val result = repository.importFromMnemonic("word ".repeat(12).trim(), "Test")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is UnsupportedOperationException)
    }

    /**
     * Tests that exportMnemonic throws UnsupportedOperationException.
     */
    @Test
    fun exportMnemonic_throwsUnsupportedOperationException() = runTest {
        // Given: Repository

        // When/Then: Should throw
        val result = repository.exportMnemonic("id-1")
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull() is UnsupportedOperationException)
    }

    // Helper functions

    private fun createSampleIdentity(
        id: String,
        label: String,
        privateKey: String,
        publicKey: String = "0".repeat(64),
        createdAt: Instant = Clock.System.now(),
        lastUsedAt: Instant? = Clock.System.now()
    ): Identity {
        return Identity(
            id = id,
            label = label,
            publicKey = publicKey,
            privateKey = privateKey,
            createdAt = createdAt,
            lastUsedAt = lastUsedAt
        )
    }
}
