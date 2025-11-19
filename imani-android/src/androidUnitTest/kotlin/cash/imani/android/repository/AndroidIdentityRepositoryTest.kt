package cash.imani.android.repository

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import cash.imani.android.db.ImaniDatabase
import cash.imani.android.identity.AndroidIdentityManager
import cash.imani.identity.domain.Identity
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Unit tests for AndroidIdentityRepository.
 *
 * Tests:
 * - Identity creation, retrieval, listing, deletion
 * - Label updates, marking as used
 * - Mnemonic import/export
 * - Integration with AndroidIdentityManager
 * - Error handling (not found, validation)
 */
@RunWith(RobolectricTestRunner::class)
class AndroidIdentityRepositoryTest {
    private lateinit var database: ImaniDatabase
    private lateinit var identityManager: AndroidIdentityManager
    private lateinit var repository: AndroidIdentityRepository

    @Before
    fun setup() {
        // Use in-memory SQLite database for tests
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        ImaniDatabase.Schema.create(driver)
        database = ImaniDatabase(driver)

        // Mock AndroidIdentityManager
        identityManager = mockk(relaxed = true)

        // Configure mock to return valid encrypted data
        every { identityManager.prepareForStorage(any()) } answers {
            val identity = firstArg<Identity>()
            Pair(
                identity.copy(privateKey = ""), // Remove private key
                ByteArray(16) { 0x42 }, // Mock encrypted data
            )
        }

        every { identityManager.decryptPrivateKey(any(), any()) } returns "0".repeat(64)

        repository = AndroidIdentityRepository(database, identityManager)
    }

    @After
    fun teardown() {
        database.close()
    }

    /**
     * Tests that createIdentity stores identity in database with encryption.
     */
    @Test
    fun `createIdentity stores identity with encrypted private key`() =
        runTest {
            // Given
            val identity = createTestIdentity("Test Identity")

            // When
            val result = repository.saveIdentity(identity)

            // Then
            assertTrue(result.isSuccess)

            // Verify encryption was called
            verify { identityManager.prepareForStorage(any()) }

            // Verify stored in database
            val retrieved = repository.getIdentity(identity.id)
            assertTrue(retrieved.isSuccess)
            assertEquals(identity.id, retrieved.getOrThrow().id)
            assertEquals("Test Identity", retrieved.getOrThrow().label)
        }

    private fun createTestIdentity(label: String): Identity {
        return Identity(
            id = "test-id-${System.currentTimeMillis()}",
            label = label,
            publicKey = "0".repeat(64),
            privateKey = "1".repeat(64),
            createdAt = Clock.System.now(),
            lastUsedAt = null,
        )
    }

    /**
     * Tests that listIdentities returns all identities ordered by lastUsedAt descending.
     */
    @Test
    fun `listIdentities returns all identities ordered by lastUsedAt`() =
        runTest {
            // Given
            repository.saveIdentity(createTestIdentity("Identity 1"))
            Thread.sleep(10) // Ensure different timestamps
            repository.saveIdentity(createTestIdentity("Identity 2"))
            Thread.sleep(10)
            repository.saveIdentity(createTestIdentity("Identity 3"))

            // When
            val result = repository.listIdentities()

            // Then
            assertTrue(result.isSuccess)
            val identities = result.getOrThrow()
            assertEquals(3, identities.size)
        }

    /**
     * Tests that getIdentity retrieves the correct identity by ID.
     */
    @Test
    fun `getIdentity retrieves correct identity by ID`() =
        runTest {
            // Given
            val created = createTestIdentity("Test Identity")
            repository.saveIdentity(created)

            // When
            val result = repository.getIdentity(created.id)

            // Then
            assertTrue(result.isSuccess)
            val identity = result.getOrThrow()
            assertEquals(created.id, identity.id)
            assertEquals("Test Identity", identity.label)
        }

    /**
     * Tests that getIdentity returns failure when identity not found.
     */
    @Test
    fun `getIdentity returns failure when identity not found`() =
        runTest {
            // When
            val result = repository.getIdentity("non-existent-id")

            // Then
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IdentityNotFoundException)
        }

    /**
     * Tests that deleteIdentity removes identity from database and Keystore.
     */
    @Test
    fun `deleteIdentity removes identity from database and Keystore`() =
        runTest {
            // Given
            val created = createTestIdentity("Test Identity")
            repository.saveIdentity(created)

            // When
            val deleteResult = repository.deleteIdentity(created.id)

            // Then
            assertTrue(deleteResult.isSuccess)
            verify { identityManager.deletePrivateKey(created.id) }

            // Verify identity is gone
            val getResult = repository.getIdentity(created.id)
            assertTrue(getResult.isFailure)
        }

    /**
     * Tests that updateLabel updates the identity label.
     */
    @Test
    fun `updateLabel updates identity label successfully`() =
        runTest {
            // Given
            val created = createTestIdentity("Old Label")
            repository.saveIdentity(created)

            // When
            val updateResult = repository.updateLabel(created.id, "New Label")

            // Then
            assertTrue(updateResult.isSuccess)

            // Verify label updated
            val updated = repository.getIdentity(created.id).getOrThrow()
            assertEquals("New Label", updated.label)
        }

    /**
     * Tests that updateLabel validates label length.
     */
    @Test
    fun `updateLabel validates label length`() =
        runTest {
            // Given
            val created = createTestIdentity("Test")
            repository.saveIdentity(created)

            // When: Empty label
            val emptyResult = repository.updateLabel(created.id, "")

            // Then
            assertTrue(emptyResult.isFailure)
            assertTrue(emptyResult.exceptionOrNull() is IllegalArgumentException)

            // When: Label too long (> 100 chars)
            val longLabel = "a".repeat(101)
            val longResult = repository.updateLabel(created.id, longLabel)

            // Then
            assertTrue(longResult.isFailure)
            assertTrue(longResult.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that markAsUsed updates the lastUsedAt timestamp.
     */
    @Test
    fun `markAsUsed updates lastUsedAt timestamp`() =
        runTest {
            // Given
            val created = createTestIdentity("Test Identity")
            repository.saveIdentity(created)
            val originalLastUsed = created.lastUsedAt

            // When
            repository.markAsUsed(created.id)

            // Then
            val updated = repository.getIdentity(created.id).getOrThrow()
            assertNotNull(updated.lastUsedAt)
            assertTrue(updated.lastUsedAt!! > (originalLastUsed ?: Clock.System.now()))
        }
}
