package cash.imani.identity.domain

import kotlinx.datetime.Clock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

/**
 * Unit tests for Identity domain model.
 * Tests validation, business logic, and immutability patterns.
 */
class IdentityTest {
    private val validPublicKey = "0".repeat(64) // 32 bytes in hex
    private val validPrivateKey = "1".repeat(64) // 32 bytes in hex

    /**
     * Tests that Identity constructor rejects blank IDs to ensure
     * all identities have valid identifiers for storage and retrieval.
     */
    @Test
    fun `constructor validates id is not blank`() {
        // Given: Empty ID string
        // When: Creating identity with blank ID
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null,
            )
        }
        // Then: Exception thrown (implicit by assertFailsWith)
    }

    /**
     * Tests that Identity constructor enforces label length constraints
     * (1-100 characters) to ensure labels are meaningful and displayable.
     */
    @Test
    fun `constructor validates label is not empty`() {
        // Given: Empty label string
        // When: Creating identity with empty label
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "test-id",
                label = "",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null,
            )
        }
        // Then: Exception thrown (implicit by assertFailsWith)
    }

    /**
     * Tests that Identity constructor rejects labels exceeding
     * maximum length to prevent storage and display issues.
     */
    @Test
    fun `constructor validates label is not too long`() {
        // Given: Label exceeding 100 characters
        // When: Creating identity with 101-character label
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "test-id",
                label = "a".repeat(101),
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null,
            )
        }
        // Then: Exception thrown (implicit by assertFailsWith)
    }

    /**
     * Tests that Identity constructor validates public key is exactly
     * 64 hex characters (32 bytes) per Nostr standard.
     */
    @Test
    fun `constructor validates public key length`() {
        // Given: Public key with incorrect length
        // When: Creating identity with 63-character public key
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = "0".repeat(63),
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null,
            )
        }
        // Then: Exception thrown (implicit by assertFailsWith)
    }

    /**
     * Tests that Identity constructor validates private key is exactly
     * 64 hex characters (32 bytes) per secp256k1 standard.
     */
    @Test
    fun `constructor validates private key length`() {
        // Given: Private key with incorrect length
        // When: Creating identity with 65-character private key
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = "1".repeat(65),
                createdAt = Clock.System.now(),
                lastUsedAt = null,
            )
        }
        // Then: Exception thrown (implicit by assertFailsWith)
    }

    /**
     * Tests that Identity considers itself active if used within
     * the last 90 days, preventing premature dormancy flagging.
     */
    @Test
    fun `isActive returns true when last used within 90 days`() {
        // Given: Identity used 30 days ago
        val now = Clock.System.now()
        val identity =
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = now.minus(100.days),
                lastUsedAt = now.minus(30.days),
            )

        // When: Checking if active
        val result = identity.isActive()

        // Then: Should be active
        assertTrue(result)
    }

    /**
     * Tests that Identity marks itself dormant when last used
     * over 90 days ago to identify stale identities.
     */
    @Test
    fun `isActive returns false when last used over 90 days ago`() {
        // Given: Identity last used 91 days ago
        val now = Clock.System.now()
        val identity =
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = now.minus(200.days),
                lastUsedAt = now.minus(91.days),
            )

        // When: Checking if active
        val result = identity.isActive()

        // Then: Should be dormant
        assertFalse(result)
    }

    /**
     * Tests that Identity falls back to createdAt when lastUsedAt is null,
     * ensuring newly created identities can be evaluated for activity.
     */
    @Test
    fun `isActive uses createdAt when lastUsedAt is null`() {
        // Given: Identity created 30 days ago, never used
        val now = Clock.System.now()
        val identity =
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = now.minus(30.days),
                lastUsedAt = null,
            )

        // When: Checking if active
        val result = identity.isActive()

        // Then: Should be active based on creation date
        assertTrue(result)
    }

    /**
     * Tests that Identity correctly identifies old, never-used identities
     * as dormant to facilitate cleanup operations.
     */
    @Test
    fun `isActive returns false when never used and created over 90 days ago`() {
        // Given: Identity created 91 days ago, never used
        val now = Clock.System.now()
        val identity =
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = now.minus(91.days),
                lastUsedAt = null,
            )

        // When: Checking if active
        val result = identity.isActive()

        // Then: Should be dormant
        assertFalse(result)
    }

    /**
     * Tests that isDormant returns false for active identities,
     * confirming it's the logical inverse of isActive.
     */
    @Test
    fun `isDormant returns false for active identity`() {
        // Given: Recently used identity
        val now = Clock.System.now()
        val activeIdentity =
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = now,
                lastUsedAt = now,
            )

        // When: Checking if dormant
        val result = activeIdentity.isDormant()

        // Then: Should not be dormant
        assertFalse(result)
    }

    /**
     * Tests that isDormant returns true for inactive identities,
     * confirming it correctly identifies stale identities.
     */
    @Test
    fun `isDormant returns true for inactive identity`() {
        // Given: Identity last used over 90 days ago
        val now = Clock.System.now()
        val dormantIdentity =
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = now.minus(100.days),
                lastUsedAt = now.minus(91.days),
            )

        // When: Checking if dormant
        val result = dormantIdentity.isDormant()

        // Then: Should be dormant
        assertTrue(result)
    }

    /**
     * Tests that withLabel creates a new Identity with updated label
     * while preserving all other fields, ensuring immutability.
     */
    @Test
    fun `withLabel creates new identity with updated label`() {
        // Given: Identity with original label
        val original =
            Identity(
                id = "test-id",
                label = "Original",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null,
            )

        // When: Updating label
        val updated = original.withLabel("Updated")

        // Then: New identity has updated label and same other fields
        assertEquals("Updated", updated.label)
        assertEquals(original.id, updated.id)
        assertEquals(original.publicKey, updated.publicKey)
        assertEquals(original.privateKey, updated.privateKey)
    }

    /**
     * Tests that withUpdatedUsage creates a new Identity with current
     * timestamp, enabling activity tracking while maintaining immutability.
     */
    @Test
    fun `withUpdatedUsage creates new identity with current timestamp`() {
        // Given: Identity with old lastUsedAt
        val now = Clock.System.now()
        val original =
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = now.minus(100.days),
                lastUsedAt = now.minus(50.days),
            )

        // When: Updating usage timestamp
        val updated = original.withUpdatedUsage()

        // Then: New identity has current timestamp and same other fields
        assertTrue(updated.lastUsedAt!! > original.lastUsedAt!!)
        assertEquals(original.id, updated.id)
        assertEquals(original.label, updated.label)
    }

    /**
     * Tests that toNpub converts the public key to bech32 format
     * with npub1 prefix per Nostr NIP-19 standard.
     */
    @Test
    fun `toNpub returns bech32 encoded public key`() {
        // Given: Identity with valid public key
        val identity =
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null,
            )

        // When: Converting to npub format
        val npub = identity.toNpub()

        // Then: Should have npub1 prefix
        assertTrue(npub.startsWith("npub1"))
    }
}
