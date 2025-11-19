package cash.imani.identity.util

import kotlin.js.JsName
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Unit tests for Bech32 encoding/decoding.
 *
 * Tests BIP-173 Bech32 implementation for Nostr key formats.
 */
class Bech32Test {
    /**
     * Tests basic Bech32 encoding and decoding round-trip.
     */
    @Test

    @JsName("encodeAndDecodeRoundTrip")
    fun `encode and decode round trip`() {
        val hrp = "test"
        val data = ByteArray(32) { it.toByte() }

        val encoded = Bech32.encode(hrp, data)
        val (decodedHrp, decodedData) = Bech32.decode(encoded)

        assertEquals(hrp, decodedHrp)
        assertTrue(data.contentEquals(decodedData))
    }

    /**
     * Tests nsec encoding and decoding.
     */
    @Test

    @JsName("encodensecAndDecodensecRoundTrip")
    fun `encodeNsec and decodeNsec round trip`() {
        val privateKey = ByteArray(32) { i -> (i * 7).toByte() }

        val nsec = Bech32.encodeNsec(privateKey)
        val decoded = Bech32.decodeNsec(nsec)

        assertTrue(nsec.startsWith("nsec1"))
        assertTrue(privateKey.contentEquals(decoded))
    }

    /**
     * Tests npub encoding and decoding.
     */
    @Test

    @JsName("encodenpubAndDecodenpubRoundTrip")
    fun `encodeNpub and decodeNpub round trip`() {
        val publicKey = ByteArray(32) { i -> (i * 13).toByte() }

        val npub = Bech32.encodeNpub(publicKey)
        val decoded = Bech32.decodeNpub(npub)

        assertTrue(npub.startsWith("npub1"))
        assertTrue(publicKey.contentEquals(decoded))
    }

    /**
     * Tests decodeNsec rejects npub.
     */
    @Test

    @JsName("decodensecRejectsNpubFormat")
    fun `decodeNsec rejects npub format`() {
        val publicKey = ByteArray(32) { i -> i.toByte() }
        val npub = Bech32.encodeNpub(publicKey)

        assertFailsWith<IllegalArgumentException> {
            Bech32.decodeNsec(npub)
        }
    }

    /**
     * Tests decodeNpub rejects nsec.
     */
    @Test

    @JsName("decodenpubRejectsNsecFormat")
    fun `decodeNpub rejects nsec format`() {
        val privateKey = ByteArray(32) { i -> i.toByte() }
        val nsec = Bech32.encodeNsec(privateKey)

        assertFailsWith<IllegalArgumentException> {
            Bech32.decodeNpub(nsec)
        }
    }

    /**
     * Tests decode rejects invalid checksum.
     */
    @Test

    @JsName("decodeRejectsInvalidChecksum")
    fun `decode rejects invalid checksum`() {
        val privateKey = ByteArray(32) { i -> i.toByte() }
        val nsec = Bech32.encodeNsec(privateKey)

        // Corrupt the checksum by changing last character
        val corrupted = nsec.dropLast(1) + "x"

        assertFailsWith<IllegalArgumentException> {
            Bech32.decodeNsec(corrupted)
        }
    }

    /**
     * Tests encode rejects empty data.
     */
    @Test

    @JsName("encodeRejectsEmptyData")
    fun `encode rejects empty data`() {
        assertFailsWith<IllegalArgumentException> {
            Bech32.encode("test", ByteArray(0))
        }
    }

    /**
     * Tests encodeNsec rejects wrong size private key.
     */
    @Test

    @JsName("encodensecRejectsNon32BytePrivateKey")
    fun `encodeNsec rejects non-32-byte private key`() {
        assertFailsWith<IllegalArgumentException> {
            Bech32.encodeNsec(ByteArray(16))
        }

        assertFailsWith<IllegalArgumentException> {
            Bech32.encodeNsec(ByteArray(64))
        }
    }

    /**
     * Tests encodeNpub rejects wrong size public key.
     */
    @Test

    @JsName("encodenpubRejectsNon32BytePublicKey")
    fun `encodeNpub rejects non-32-byte public key`() {
        assertFailsWith<IllegalArgumentException> {
            Bech32.encodeNpub(ByteArray(16))
        }

        assertFailsWith<IllegalArgumentException> {
            Bech32.encodeNpub(ByteArray(64))
        }
    }

    /**
     * Tests decode handles lowercase input correctly.
     *
     * Note: Bech32 is case-insensitive but all characters in the data part
     * must be the same case. The decode function converts to lowercase internally.
     */
    @Test

    @JsName("decodeHandlesLowercaseInputCorrectly")
    fun `decode handles lowercase input correctly`() {
        val privateKey = ByteArray(32) { i -> i.toByte() }
        val nsec = Bech32.encodeNsec(privateKey)

        // Test lowercase (should work)
        val decodedLower = Bech32.decodeNsec(nsec.lowercase())
        assertTrue(privateKey.contentEquals(decodedLower))

        // Test that the encoded nsec is already lowercase
        assertTrue(nsec == nsec.lowercase())
    }

    /**
     * Tests known Nostr test vector (if available).
     *
     * This verifies compatibility with standard Nostr implementations.
     */
    @Test

    @JsName("decodeKnownNostrNsecTestVector")
    fun `decode known Nostr nsec test vector`() {
        // Example nsec from Nostr documentation
        // Note: This is a test vector, not a real private key
        val testNsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"
        val expectedHex = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa"

        val decoded = Bech32.decodeNsec(testNsec)
        assertEquals(expectedHex, decoded.toHex())
    }

    /**
     * Tests known Nostr test vector for npub.
     */
    @Test

    @JsName("decodeKnownNostrNpubTestVector")
    fun `decode known Nostr npub test vector`() {
        // Example npub from Nostr documentation
        val testNpub = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg"
        val expectedHex = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e"

        val decoded = Bech32.decodeNpub(testNpub)
        assertEquals(expectedHex, decoded.toHex())
    }
}
