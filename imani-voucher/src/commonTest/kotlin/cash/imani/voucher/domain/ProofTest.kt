package cash.imani.voucher.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ProofTest {

    @Test
    fun `proof has correct fields`() {
        val proof = Proof(
            amount = 100,
            secret = "my-secret",
            C = "02abcdef",
            id = "keyset-1"
        )

        assertEquals(100, proof.amount)
        assertEquals("my-secret", proof.secret)
        assertEquals("02abcdef", proof.C)
        assertEquals("keyset-1", proof.id)
    }

    @Test
    fun `computeY returns placeholder value`() {
        val proof = Proof(
            amount = 100,
            secret = "test-secret-for-hashing",
            C = "02abcdef",
            id = "keyset-1"
        )

        val y = proof.computeY()

        // Currently returns placeholder (starts with "02" and contains part of secret)
        assertTrue(y.startsWith("02"))
        assertTrue(y.length > 10)
    }
}
