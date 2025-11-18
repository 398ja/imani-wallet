package cash.imani.identity.domain

import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

class IdentityTest {

    private val validPublicKey = "0".repeat(64) // 32 bytes in hex
    private val validPrivateKey = "1".repeat(64) // 32 bytes in hex

    @Test
    fun `constructor validates id is not blank`() {
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null
            )
        }
    }

    @Test
    fun `constructor validates label length`() {
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "test-id",
                label = "", // Empty after trim
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null
            )
        }

        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "test-id",
                label = "a".repeat(101), // Too long
                publicKey = validPublicKey,
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null
            )
        }
    }

    @Test
    fun `constructor validates public key length`() {
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = "0".repeat(63), // Too short
                privateKey = validPrivateKey,
                createdAt = Clock.System.now(),
                lastUsedAt = null
            )
        }
    }

    @Test
    fun `constructor validates private key length`() {
        assertFailsWith<IllegalArgumentException> {
            Identity(
                id = "test-id",
                label = "Test",
                publicKey = validPublicKey,
                privateKey = "1".repeat(65), // Too long
                createdAt = Clock.System.now(),
                lastUsedAt = null
            )
        }
    }

    @Test
    fun `isActive returns true when last used within 90 days`() {
        val now = Clock.System.now()
        val identity = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = now.minus(100.days),
            lastUsedAt = now.minus(30.days)
        )
        assertTrue(identity.isActive())
    }

    @Test
    fun `isActive returns false when last used over 90 days ago`() {
        val now = Clock.System.now()
        val identity = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = now.minus(200.days),
            lastUsedAt = now.minus(91.days)
        )
        assertFalse(identity.isActive())
    }

    @Test
    fun `isActive uses createdAt when lastUsedAt is null`() {
        val now = Clock.System.now()
        val identity = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = now.minus(30.days),
            lastUsedAt = null
        )
        assertTrue(identity.isActive())
    }

    @Test
    fun `isActive returns false when never used and created over 90 days ago`() {
        val now = Clock.System.now()
        val identity = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = now.minus(91.days),
            lastUsedAt = null
        )
        assertFalse(identity.isActive())
    }

    @Test
    fun `isDormant is opposite of isActive`() {
        val now = Clock.System.now()
        val activeIdentity = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = now,
            lastUsedAt = now
        )
        assertFalse(activeIdentity.isDormant())

        val dormantIdentity = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = now.minus(100.days),
            lastUsedAt = now.minus(91.days)
        )
        assertTrue(dormantIdentity.isDormant())
    }

    @Test
    fun `withLabel creates new identity with updated label`() {
        val original = Identity(
            id = "test-id",
            label = "Original",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = Clock.System.now(),
            lastUsedAt = null
        )

        val updated = original.withLabel("Updated")

        assertEquals("Updated", updated.label)
        assertEquals(original.id, updated.id)
        assertEquals(original.publicKey, updated.publicKey)
        assertEquals(original.privateKey, updated.privateKey)
    }

    @Test
    fun `withUpdatedUsage creates new identity with current timestamp`() {
        val now = Clock.System.now()
        val original = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = now.minus(100.days),
            lastUsedAt = now.minus(50.days)
        )

        val updated = original.withUpdatedUsage()

        assertTrue(updated.lastUsedAt!! > original.lastUsedAt!!)
        assertEquals(original.id, updated.id)
        assertEquals(original.label, updated.label)
    }

    @Test
    fun `toNpub returns bech32 encoded public key`() {
        val identity = Identity(
            id = "test-id",
            label = "Test",
            publicKey = validPublicKey,
            privateKey = validPrivateKey,
            createdAt = Clock.System.now(),
            lastUsedAt = null
        )

        val npub = identity.toNpub()
        assertTrue(npub.startsWith("npub1"))
    }
}
