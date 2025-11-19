package cash.imani.identity.usecases

import kotlin.js.JsName
import cash.imani.identity.MockBip39Adapter
import cash.imani.identity.MockCryptoAdapter
import cash.imani.identity.domain.NostrEvent
import cash.imani.identity.repository.createIdentityRepository
import cash.imani.identity.util.hexToBytes
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Unit tests for identity use cases.
 *
 * Tests business logic layer between UI and repository.
 */
class UseCasesTest {
    private val cryptoAdapter = MockCryptoAdapter()
    private val bip39Adapter = MockBip39Adapter()
    private val repository = createIdentityRepository(cryptoAdapter, bip39Adapter)

    /**
     * Tests CreateIdentityUseCase success path.
     */
    @Test
    @JsName("createidentityusecaseCreatesIdentityAndReturnsMnemonic")
    fun `CreateIdentityUseCase creates identity and returns mnemonic`() =
        runTest {
            // Given: CreateIdentityUseCase
            val useCase = CreateIdentityUseCase(repository)

            // When: Creating an identity
            val result = useCase("Test Identity")

            // Then: Should succeed with identity and mnemonic
            assertTrue(result.isSuccess)
            val createResult = result.getOrThrow()
            assertEquals("Test Identity", createResult.identity.label)
            assertNotNull(createResult.mnemonic)

            // And: Mnemonic should be 12 words
            val words = createResult.mnemonic.split(" ")
            assertEquals(12, words.size)
        }

    /**
     * Tests CreateIdentityUseCase rejects empty label.
     */
    @Test
    @JsName("createidentityusecaseRejectsEmptyLabel")
    fun `CreateIdentityUseCase rejects empty label`() =
        runTest {
            // Given: CreateIdentityUseCase
            val useCase = CreateIdentityUseCase(repository)

            // When: Creating identity with empty label
            val result = useCase("")

            // Then: Should fail with validation error
            assertTrue(result.isFailure)
        }

    /**
     * Tests ListIdentitiesUseCase returns all identities.
     */
    @Test
    @JsName("listidentitiesusecaseReturnsAllIdentities")
    fun `ListIdentitiesUseCase returns all identities`() =
        runTest {
            // Given: Repository with two identities
            val createUseCase = CreateIdentityUseCase(repository)
            createUseCase("Identity 1")
            createUseCase("Identity 2")

            // When: Listing identities
            val listUseCase = ListIdentitiesUseCase(repository)
            val result = listUseCase()

            // Then: Should return both identities
            assertTrue(result.isSuccess)
            val identities = result.getOrThrow()
            assertEquals(2, identities.size)
        }

    /**
     * Tests ListIdentitiesUseCase filters inactive identities.
     */
    @Test
    @JsName("listidentitiesusecaseCanFilterInactiveIdentities")
    fun `ListIdentitiesUseCase can filter inactive identities`() =
        runTest {
            // Given: Repository with identities
            val createUseCase = CreateIdentityUseCase(repository)
            createUseCase("Active Identity")

            // When: Listing only active identities
            val listUseCase = ListIdentitiesUseCase(repository)
            val result = listUseCase(includeInactive = false)

            // Then: Should return active identities only
            assertTrue(result.isSuccess)
            val identities = result.getOrThrow()
            assertTrue(identities.all { it.isActive() })
        }

    /**
     * Tests ImportIdentityUseCase with valid mnemonic.
     */
    @Test
    @JsName("importidentityusecaseImportsIdentityFromMnemonic")
    fun `ImportIdentityUseCase imports identity from mnemonic`() =
        runTest {
            // Given: Exported mnemonic from existing identity
            val createUseCase = CreateIdentityUseCase(repository)
            val created = createUseCase("Original").getOrThrow()
            val mnemonic = created.mnemonic

            // When: Importing from mnemonic
            val importUseCase = ImportIdentityUseCase(repository)
            val result = importUseCase(mnemonic, "Imported")

            // Then: Should succeed with new identity
            assertTrue(result.isSuccess)
            val imported = result.getOrThrow()
            assertEquals("Imported", imported.label)
        }

    /**
     * Tests ImportIdentityUseCase normalizes mnemonic input.
     */
    @Test
    @JsName("importidentityusecaseNormalizesMnemonicWithExtraSpaces")
    fun `ImportIdentityUseCase normalizes mnemonic with extra spaces`() =
        runTest {
            // Given: Exported mnemonic
            val createUseCase = CreateIdentityUseCase(repository)
            val created = createUseCase("Test").getOrThrow()
            val mnemonic = created.mnemonic

            // When: Importing with extra spaces and mixed case
            val mnemonicWithSpaces = "  $mnemonic   "
            val importUseCase = ImportIdentityUseCase(repository)
            val result = importUseCase(mnemonicWithSpaces, "Imported")

            // Then: Should succeed (normalization works)
            assertTrue(result.isSuccess)
        }

    /**
     * Tests ImportIdentityUseCase rejects empty label.
     */
    @Test
    @JsName("importidentityusecaseRejectsEmptyLabel")
    fun `ImportIdentityUseCase rejects empty label`() =
        runTest {
            // Given: Valid mnemonic
            val createUseCase = CreateIdentityUseCase(repository)
            val created = createUseCase("Test").getOrThrow()
            val mnemonic = created.mnemonic

            // When: Importing with empty label
            val importUseCase = ImportIdentityUseCase(repository)
            val result = importUseCase(mnemonic, "")

            // Then: Should fail with validation error
            assertTrue(result.isFailure)
        }

    /**
     * Tests ImportIdentityFromNsecUseCase imports identity from nsec.
     */
    @Test
    @JsName("importidentityfromnsecusecaseImportsIdentityFromNsec")
    fun `ImportIdentityFromNsecUseCase imports identity from nsec`() =
        runTest {
            // Given: Create an identity and export its nsec
            val createUseCase = CreateIdentityUseCase(repository)
            val created = createUseCase("Original").getOrThrow()
            val nsec = repository.exportNsec(created.identity.id).getOrThrow()

            // When: Importing from nsec
            val importUseCase = ImportIdentityFromNsecUseCase(repository)
            val result = importUseCase(nsec, "Imported from nsec")

            // Then: Should succeed with new identity
            assertTrue(result.isSuccess)
            val imported = result.getOrThrow()
            assertEquals("Imported from nsec", imported.label)
            // Public keys should match since derived from same private key
            assertEquals(created.identity.publicKey, imported.publicKey)
        }

    /**
     * Tests ImportIdentityFromNsecUseCase normalizes nsec input.
     */
    @Test
    @JsName("importidentityfromnsecusecaseNormalizesNsecWithExtraSpaces")
    fun `ImportIdentityFromNsecUseCase normalizes nsec with extra spaces`() =
        runTest {
            // Given: Export nsec
            val createUseCase = CreateIdentityUseCase(repository)
            val created = createUseCase("Test").getOrThrow()
            val nsec = repository.exportNsec(created.identity.id).getOrThrow()

            // When: Importing with extra spaces and uppercase
            val nsecWithSpaces = "  ${nsec.uppercase()}   "
            val importUseCase = ImportIdentityFromNsecUseCase(repository)
            val result = importUseCase(nsecWithSpaces, "Imported")

            // Then: Should succeed (normalization works)
            assertTrue(result.isSuccess)
        }

    /**
     * Tests ImportIdentityFromNsecUseCase rejects empty label.
     */
    @Test
    @JsName("importidentityfromnsecusecaseRejectsEmptyLabel")
    fun `ImportIdentityFromNsecUseCase rejects empty label`() =
        runTest {
            // Given: Valid nsec
            val createUseCase = CreateIdentityUseCase(repository)
            val created = createUseCase("Test").getOrThrow()
            val nsec = repository.exportNsec(created.identity.id).getOrThrow()

            // When: Importing with empty label
            val importUseCase = ImportIdentityFromNsecUseCase(repository)
            val result = importUseCase(nsec, "")

            // Then: Should fail with validation error
            assertTrue(result.isFailure)
        }

    /**
     * Tests ImportIdentityFromNsecUseCase rejects invalid nsec format.
     */
    @Test
    @JsName("importidentityfromnsecusecaseRejectsInvalidNsecFormat")
    fun `ImportIdentityFromNsecUseCase rejects invalid nsec format`() =
        runTest {
            // Given: Invalid nsec (npub instead of nsec)
            val createUseCase = CreateIdentityUseCase(repository)
            val created = createUseCase("Test").getOrThrow()

            // Get the public key and encode as npub (wrong format for import)
            val npub = cash.imani.identity.util.Bech32.encodeNpub(created.identity.publicKey.hexToBytes())

            // When: Trying to import with npub
            val importUseCase = ImportIdentityFromNsecUseCase(repository)
            val result = importUseCase(npub, "Test")

            // Then: Should fail with format error
            assertTrue(result.isFailure)
        }

    /**
     * Tests SignNostrEventUseCase signs event successfully.
     */
    @Test
    @JsName("signnostreventusecaseSignsNostrEvent")
    fun `SignNostrEventUseCase signs Nostr event`() =
        runTest {
            // Given: Identity and unsigned event
            val createUseCase = CreateIdentityUseCase(repository)
            val identity = createUseCase("Test").getOrThrow().identity

            val event =
                NostrEvent(
                    pubkey = identity.publicKey,
                    created_at = Clock.System.now().epochSeconds,
                    kind = NostrEvent.Kind.TEXT_NOTE,
                    tags = emptyList(),
                    content = "Hello, Nostr!",
                )

            // When: Signing the event
            val signUseCase = SignNostrEventUseCase(repository, cryptoAdapter)
            val result = signUseCase(identity.id, event)

            // Then: Should succeed with signed event
            assertTrue(result.isSuccess, "Failed to sign event: ${result.exceptionOrNull()?.message}")
            val signedEvent = result.getOrThrow()
            assertEquals(event.pubkey, signedEvent.pubkey)
            assertEquals(event.content, signedEvent.content)
            assertEquals(64, signedEvent.id.length) // 32 bytes hex
            assertEquals(128, signedEvent.sig.length) // 64 bytes hex
        }

    /**
     * Tests SignNostrEventUseCase validates event pubkey matches identity.
     */
    @Test
    @JsName("signnostreventusecaseRejectsMismatchedPubkey")
    fun `SignNostrEventUseCase rejects mismatched pubkey`() =
        runTest {
            // Given: Identity and event with different pubkey
            val createUseCase = CreateIdentityUseCase(repository)
            val identity = createUseCase("Test").getOrThrow().identity

            val event =
                NostrEvent(
                    // Different pubkey
                    pubkey = "0".repeat(64),
                    created_at = Clock.System.now().epochSeconds,
                    kind = NostrEvent.Kind.TEXT_NOTE,
                    tags = emptyList(),
                    content = "Test",
                )

            // When: Signing the event
            val signUseCase = SignNostrEventUseCase(repository, cryptoAdapter)
            val result = signUseCase(identity.id, event)

            // Then: Should fail with validation error
            assertTrue(result.isFailure)
        }

    /**
     * Tests SignNostrEventUseCase convenience method for text notes.
     */
    @Test
    @JsName("signnostreventusecaseSigntextnoteCreatesAndSignsTextNote")
    fun `SignNostrEventUseCase signTextNote creates and signs text note`() =
        runTest {
            // Given: Identity
            val createUseCase = CreateIdentityUseCase(repository)
            val identity = createUseCase("Test").getOrThrow().identity

            // When: Signing a text note using convenience method
            val signUseCase = SignNostrEventUseCase(repository, cryptoAdapter)
            val result = signUseCase.signTextNote(identity.id, "Hello, Imani Wallet!")

            // Then: Should succeed with signed text note (kind 1)
            assertTrue(result.isSuccess)
            val signedEvent = result.getOrThrow()
            assertEquals(NostrEvent.Kind.TEXT_NOTE, signedEvent.kind)
            assertEquals("Hello, Imani Wallet!", signedEvent.content)
        }

    /**
     * Tests that signed events can be verified.
     */
    @Test
    @JsName("signednostreventVerifiesCorrectly")
    fun `SignedNostrEvent verifies correctly`() =
        runTest {
            // Given: Signed event
            val createUseCase = CreateIdentityUseCase(repository)
            val identity = createUseCase("Test").getOrThrow().identity

            val signUseCase = SignNostrEventUseCase(repository, cryptoAdapter)
            val signedEvent =
                signUseCase.signTextNote(identity.id, "Test message")
                    .getOrThrow()

            // When: Verifying the signature
            val isValid = signedEvent.verifySignature(cryptoAdapter)

            // Then: Should verify successfully
            assertTrue(isValid)
        }

    /**
     * Tests that tampered events fail verification.
     */
    @Test
    @JsName("signednostreventWithTamperedContentFailsVerification")
    fun `SignedNostrEvent with tampered content fails verification`() =
        runTest {
            // Given: Signed event
            val createUseCase = CreateIdentityUseCase(repository)
            val identity = createUseCase("Test").getOrThrow().identity

            val signUseCase = SignNostrEventUseCase(repository, cryptoAdapter)
            val signedEvent =
                signUseCase.signTextNote(identity.id, "Original message")
                    .getOrThrow()

            // When: Tampering with content and verifying
            val tamperedEvent = signedEvent.copy(content = "Tampered message")
            val isValid = tamperedEvent.verifySignature(cryptoAdapter)

            // Then: Verification should fail
            assertFalse(isValid)
        }
}
