package cash.imani.voucher.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for Proof domain model.
 * Tests NUT-00 compliant proof structure and Y-coordinate computation.
 */
class ProofTest {
    /**
     * Tests that Proof data class correctly stores all required fields
     * per NUT-00 specification (amount, secret, C, id).
     */
    @Test
    fun `proof has correct fields`() {
        // Given: Proof with known values
        val proof =
            Proof(
                amount = 100,
                secret = "my-secret",
                C = "02abcdef",
                id = "keyset-1",
            )

        // When: Accessing fields
        // Then: All fields should match constructor values
        assertEquals(100, proof.amount)
        assertEquals("my-secret", proof.secret)
        assertEquals("02abcdef", proof.C)
        assertEquals("keyset-1", proof.id)
    }

    /**
     * Tests that computeY returns placeholder Y-coordinate value,
     * as full SHA-256 hashing will be implemented in Phase 1+.
     */
    @Test
    fun `computeY returns placeholder value`() {
        // Given: Proof with test secret
        val proof =
            Proof(
                amount = 100,
                secret = "test-secret-for-hashing",
                C = "02abcdef",
                id = "keyset-1",
            )

        // When: Computing Y-coordinate
        val y = proof.computeY()

        // Then: Phase 0 returns placeholder (starts with "02", non-trivial length)
        assertTrue(y.startsWith("02"))
        assertTrue(y.length > 10)
    }
}
