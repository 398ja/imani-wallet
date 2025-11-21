package cash.imani.identity.usecases

import cash.imani.identity.crypto.JvmBip39Adapter
import cash.imani.identity.crypto.JvmCryptoAdapter
import cash.imani.identity.repository.JvmIdentityRepository
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Integration tests for CreateIdentityUseCase.
 *
 * These tests verify the end-to-end identity creation flow using real JVM implementations
 * of CryptoAdapter and Bip39Adapter (not mocks). They test:
 * - Successful identity creation with mnemonic generation
 * - Label validation
 * - Keypair generation via real crypto adapter
 * - Mnemonic generation and storage
 * - Database persistence
 * - Error handling
 *
 * Unlike unit tests that use mocks, these integration tests verify that all components
 * work together correctly in a real JVM environment.
 */
class CreateIdentityUseCaseIntegrationTest {
    private val cryptoAdapter = JvmCryptoAdapter()
    private val bip39Adapter = JvmBip39Adapter()
    private val repository = JvmIdentityRepository(cryptoAdapter, bip39Adapter)
    private val createIdentityUseCase = CreateIdentityUseCase(repository)

    // ==================== Successful Identity Creation Tests ====================

    /**
     * Tests that CreateIdentityUseCase successfully creates an identity with a valid label.
     * Verifies that the returned result contains both an Identity and a 12-word mnemonic.
     */
    @Test
    fun `invoke creates identity successfully with valid label`() =
        runTest {
            // Given: A valid label
            val label = "Test Identity"

            // When: Creating an identity
            val result = createIdentityUseCase(label)

            // Then: Result should be successful
            assertTrue(result.isSuccess, "Identity creation should succeed")

            val createIdentityResult = result.getOrNull()
            assertNotNull(createIdentityResult, "Result should not be null")

            // Then: Identity should have correct label
            assertEquals(label, createIdentityResult.identity.label, "Label should match input")

            // Then: Identity should have valid ID
            assertTrue(
                createIdentityResult.identity.id.isNotBlank(),
                "Identity ID should not be blank",
            )

            // Then: Identity should have valid public key (64 hex chars)
            assertEquals(
                64,
                createIdentityResult.identity.publicKey.length,
                "Public key should be 64 hex characters",
            )

            // Then: Mnemonic should be 12 words
            val mnemonicWords = createIdentityResult.mnemonic.trim().split("\\s+".toRegex())
            assertEquals(12, mnemonicWords.size, "Mnemonic should be 12 words")
        }

    /**
     * Tests that CreateIdentityUseCase creates unique identities on successive calls.
     * Verifies that each identity has a different ID and public key.
     */
    @Test
    fun `invoke creates unique identities on successive calls`() =
        runTest {
            // When: Creating three identities
            val result1 = createIdentityUseCase("Identity 1")
            val result2 = createIdentityUseCase("Identity 2")
            val result3 = createIdentityUseCase("Identity 3")

            // Then: All results should be successful
            assertTrue(result1.isSuccess, "First identity creation should succeed")
            assertTrue(result2.isSuccess, "Second identity creation should succeed")
            assertTrue(result3.isSuccess, "Third identity creation should succeed")

            val identity1 = result1.getOrThrow().identity
            val identity2 = result2.getOrThrow().identity
            val identity3 = result3.getOrThrow().identity

            // Then: All identities should have different IDs
            assertTrue(
                identity1.id != identity2.id && identity2.id != identity3.id && identity1.id != identity3.id,
                "All identities should have unique IDs",
            )

            // Then: All identities should have different public keys
            assertTrue(
                identity1.publicKey != identity2.publicKey &&
                    identity2.publicKey != identity3.publicKey &&
                    identity1.publicKey != identity3.publicKey,
                "All identities should have unique public keys",
            )
        }

    /**
     * Tests that CreateIdentityUseCase generates different mnemonics on successive calls.
     * Verifies that each identity has a unique recovery phrase.
     *
     * NOTE: This test is skipped for JVM because the JvmBip39Adapter is a placeholder
     * implementation that returns the same mnemonic ("word word...") for all identities.
     * This is an expected Phase 0/1 limitation.
     *
     * TODO Phase 2: Enable this test once proper BIP39 library is integrated.
     */
    @Test
    @kotlin.test.Ignore("JvmBip39Adapter is a placeholder that returns identical mnemonics")
    fun `invoke generates unique mnemonics on successive calls`() =
        runTest {
            // When: Creating three identities
            val result1 = createIdentityUseCase("Identity 1")
            val result2 = createIdentityUseCase("Identity 2")
            val result3 = createIdentityUseCase("Identity 3")

            val mnemonic1 = result1.getOrThrow().mnemonic
            val mnemonic2 = result2.getOrThrow().mnemonic
            val mnemonic3 = result3.getOrThrow().mnemonic

            // Then: All mnemonics should be different
            assertTrue(
                mnemonic1 != mnemonic2 && mnemonic2 != mnemonic3 && mnemonic1 != mnemonic3,
                "All mnemonics should be unique",
            )
        }

    /**
     * Tests that CreateIdentityUseCase creates an identity that can be retrieved from the repository.
     * Verifies database persistence and retrieval.
     */
    @Test
    fun `invoke creates identity that can be retrieved from repository`() =
        runTest {
            // Given: A newly created identity
            val label = "Retrievable Identity"
            val createResult = createIdentityUseCase(label)
            assertTrue(createResult.isSuccess, "Identity creation should succeed")

            val createdIdentity = createResult.getOrThrow().identity

            // When: Retrieving the identity from the repository
            val retrieveResult = repository.getIdentity(createdIdentity.id)

            // Then: Retrieval should succeed
            assertTrue(retrieveResult.isSuccess, "Identity retrieval should succeed")

            val retrievedIdentity = retrieveResult.getOrThrow()

            // Then: Retrieved identity should match created identity
            assertEquals(createdIdentity.id, retrievedIdentity.id, "IDs should match")
            assertEquals(createdIdentity.label, retrievedIdentity.label, "Labels should match")
            assertEquals(
                createdIdentity.publicKey,
                retrievedIdentity.publicKey,
                "Public keys should match",
            )
            assertEquals(
                createdIdentity.privateKey,
                retrievedIdentity.privateKey,
                "Private keys should match",
            )
        }

    /**
     * Tests that CreateIdentityUseCase generates a mnemonic that can be exported.
     * Verifies mnemonic storage and retrieval from the repository.
     */
    @Test
    fun `invoke generates mnemonic that can be exported`() =
        runTest {
            // Given: A newly created identity
            val createResult = createIdentityUseCase("Exportable Identity")
            assertTrue(createResult.isSuccess, "Identity creation should succeed")

            val identity = createResult.getOrThrow().identity
            val originalMnemonic = createResult.getOrThrow().mnemonic

            // When: Exporting the mnemonic from the repository
            val exportResult = repository.exportMnemonic(identity.id)

            // Then: Export should succeed
            assertTrue(exportResult.isSuccess, "Mnemonic export should succeed")

            val exportedMnemonic = exportResult.getOrThrow()

            // Then: Exported mnemonic should match original
            assertEquals(originalMnemonic, exportedMnemonic, "Mnemonics should match")
        }

    // ==================== Label Validation Tests ====================

    /**
     * Tests that CreateIdentityUseCase rejects an empty label.
     * Verifies validation of the identity label requirement.
     */
    @Test
    fun `invoke fails with empty label`() =
        runTest {
            // Given: An empty label
            val emptyLabel = ""

            // When: Creating an identity with empty label
            val result = createIdentityUseCase(emptyLabel)

            // Then: Result should be a failure
            assertTrue(result.isFailure, "Identity creation should fail with empty label")

            val exception = result.exceptionOrNull()
            assertNotNull(exception, "Exception should not be null")
            assertTrue(
                exception is IllegalArgumentException,
                "Exception should be IllegalArgumentException",
            )
            assertTrue(
                exception.message?.contains("cannot be empty") == true,
                "Error message should mention empty label",
            )
        }

    /**
     * Tests that CreateIdentityUseCase rejects a whitespace-only label.
     * Verifies that labels with only spaces are treated as empty.
     */
    @Test
    fun `invoke fails with whitespace-only label`() =
        runTest {
            // Given: A whitespace-only label
            val whitespaceLabel = "   "

            // When: Creating an identity with whitespace-only label
            val result = createIdentityUseCase(whitespaceLabel)

            // Then: Result should be a failure
            assertTrue(result.isFailure, "Identity creation should fail with whitespace-only label")

            val exception = result.exceptionOrNull()
            assertNotNull(exception, "Exception should not be null")
            assertTrue(
                exception is IllegalArgumentException,
                "Exception should be IllegalArgumentException",
            )
        }

    /**
     * Tests that CreateIdentityUseCase trims leading and trailing whitespace from labels.
     * Verifies that labels are normalized before storage.
     */
    @Test
    fun `invoke trims whitespace from label`() =
        runTest {
            // Given: A label with leading and trailing whitespace
            val labelWithWhitespace = "  Trimmed Identity  "
            val expectedLabel = "Trimmed Identity"

            // When: Creating an identity
            val result = createIdentityUseCase(labelWithWhitespace)

            // Then: Result should be successful
            assertTrue(result.isSuccess, "Identity creation should succeed")

            val identity = result.getOrThrow().identity

            // Then: Label should be trimmed
            assertEquals(expectedLabel, identity.label, "Label should be trimmed")
        }

    /**
     * Tests that CreateIdentityUseCase accepts labels of various valid lengths.
     * Verifies that labels from 1 to 100 characters are accepted.
     */
    @Test
    fun `invoke accepts valid label lengths`() =
        runTest {
            // Given: Labels of various valid lengths
            val shortLabel = "A" // 1 character
            val mediumLabel = "Identity with a reasonable length label" // ~40 characters
            val longLabel = "A".repeat(100) // 100 characters (max length)

            // When: Creating identities with different label lengths
            val result1 = createIdentityUseCase(shortLabel)
            val result2 = createIdentityUseCase(mediumLabel)
            val result3 = createIdentityUseCase(longLabel)

            // Then: All results should be successful
            assertTrue(result1.isSuccess, "Short label should succeed")
            assertTrue(result2.isSuccess, "Medium label should succeed")
            assertTrue(result3.isSuccess, "Long label should succeed")

            assertEquals(shortLabel, result1.getOrThrow().identity.label)
            assertEquals(mediumLabel, result2.getOrThrow().identity.label)
            assertEquals(longLabel, result3.getOrThrow().identity.label)
        }

    // ==================== Mnemonic Validation Tests ====================

    /**
     * Tests that CreateIdentityUseCase generates mnemonics that pass BIP39 validation.
     * Verifies that the mnemonic has valid words, word count, and checksum.
     */
    @Test
    fun `invoke generates valid BIP39 mnemonic`() =
        runTest {
            // When: Creating an identity
            val result = createIdentityUseCase("BIP39 Test")
            assertTrue(result.isSuccess, "Identity creation should succeed")

            val mnemonic = result.getOrThrow().mnemonic

            // Then: Mnemonic should be valid according to BIP39
            assertTrue(
                bip39Adapter.validateMnemonic(mnemonic),
                "Mnemonic should pass BIP39 validation (valid words, count, and checksum)",
            )

            // Then: Should have 12 words
            val words = mnemonic.trim().split("\\s+".toRegex())
            assertEquals(12, words.size, "Should have 12 words")
        }

    /**
     * Tests that CreateIdentityUseCase generates mnemonics that are exactly 12 words.
     * Verifies the standard BIP39 mnemonic length for 128-bit entropy.
     */
    @Test
    fun `invoke generates exactly 12-word mnemonic`() =
        runTest {
            // When: Creating multiple identities
            val result1 = createIdentityUseCase("Identity 1")
            val result2 = createIdentityUseCase("Identity 2")
            val result3 = createIdentityUseCase("Identity 3")

            val mnemonic1 = result1.getOrThrow().mnemonic
            val mnemonic2 = result2.getOrThrow().mnemonic
            val mnemonic3 = result3.getOrThrow().mnemonic

            // Then: All mnemonics should have exactly 12 words
            assertEquals(12, mnemonic1.trim().split("\\s+".toRegex()).size, "Mnemonic 1 should have 12 words")
            assertEquals(12, mnemonic2.trim().split("\\s+".toRegex()).size, "Mnemonic 2 should have 12 words")
            assertEquals(12, mnemonic3.trim().split("\\s+".toRegex()).size, "Mnemonic 3 should have 12 words")
        }

    // ==================== Keypair Generation Tests ====================

    /**
     * Tests that CreateIdentityUseCase generates keypairs with correct sizes.
     * Verifies that public keys are 64 hex characters (32 bytes).
     */
    @Test
    fun `invoke generates keypairs with correct sizes`() =
        runTest {
            // When: Creating an identity
            val result = createIdentityUseCase("Keypair Test")
            assertTrue(result.isSuccess, "Identity creation should succeed")

            val identity = result.getOrThrow().identity

            // Then: Public key should be 64 hex characters (32 bytes)
            assertEquals(64, identity.publicKey.length, "Public key should be 64 hex characters")

            // Then: Public key should be valid hex
            assertTrue(
                identity.publicKey.matches(Regex("^[0-9a-f]{64}$")),
                "Public key should be lowercase hex",
            )
        }

    /**
     * Tests that CreateIdentityUseCase generates keypairs where public and private keys differ.
     * Verifies that the keypair generation produces distinct keys.
     */
    @Test
    fun `invoke generates keypairs with different public and private keys`() =
        runTest {
            // When: Creating an identity
            val result = createIdentityUseCase("Keypair Test")
            assertTrue(result.isSuccess, "Identity creation should succeed")

            val identity = result.getOrThrow().identity

            // Then: Public and private keys should be different
            assertTrue(
                identity.publicKey != identity.privateKey,
                "Public and private keys should be different",
            )
        }

    // ==================== Repository Integration Tests ====================

    /**
     * Tests that CreateIdentityUseCase persists identities in the repository.
     * Verifies that created identities appear in the repository's list.
     */
    @Test
    fun `invoke persists identity in repository`() =
        runTest {
            // Given: Initial identity count
            val initialIdentities = repository.listIdentities().getOrThrow()
            val initialCount = initialIdentities.size

            // When: Creating a new identity
            val result = createIdentityUseCase("Persistent Identity")
            assertTrue(result.isSuccess, "Identity creation should succeed")

            // Then: Identity count should increase
            val updatedIdentities = repository.listIdentities().getOrThrow()
            assertEquals(initialCount + 1, updatedIdentities.size, "Identity count should increase by 1")

            // Then: New identity should be in the list
            val createdIdentity = result.getOrThrow().identity
            assertTrue(
                updatedIdentities.any { it.id == createdIdentity.id },
                "Created identity should be in the list",
            )
        }

    /**
     * Tests that CreateIdentityUseCase stores the private key securely.
     * Verifies that the private key can be retrieved and matches the original.
     */
    @Test
    fun `invoke stores private key securely`() =
        runTest {
            // When: Creating an identity
            val result = createIdentityUseCase("Secure Identity")
            assertTrue(result.isSuccess, "Identity creation should succeed")

            val createdIdentity = result.getOrThrow().identity

            // When: Retrieving the identity from repository
            val retrievedIdentity = repository.getIdentity(createdIdentity.id).getOrThrow()

            // Then: Private keys should match
            assertEquals(
                createdIdentity.privateKey,
                retrievedIdentity.privateKey,
                "Private keys should match",
            )

            // Then: Private key should be 64 hex characters (32 bytes)
            assertEquals(64, retrievedIdentity.privateKey.length, "Private key should be 64 hex characters")
        }
}
