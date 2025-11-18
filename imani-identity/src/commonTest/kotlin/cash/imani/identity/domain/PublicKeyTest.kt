package cash.imani.identity.domain

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Unit tests for PublicKey domain model.
 * Tests validation, hex conversion, and defensive copying.
 */
class PublicKeyTest {

    /**
     * Tests that PublicKey constructor validates key length is exactly
     * 32 bytes per Nostr standard, rejecting shorter or longer keys.
     */
    @Test
    fun `constructor accepts valid 32-byte key`() {
        // Given: Valid 32-byte array
        val validBytes = ByteArray(32) { it.toByte() }

        // When: Creating PublicKey
        val publicKey = PublicKey(validBytes)

        // Then: Should not throw (implicit by successful creation)
        assertEquals(32, publicKey.bytes.size)
    }

    /**
     * Tests that PublicKey constructor rejects keys shorter than
     * 32 bytes to ensure cryptographic validity.
     */
    @Test
    fun `constructor rejects key shorter than 32 bytes`() {
        // Given: 31-byte array (too short)
        val tooShort = ByteArray(31) { it.toByte() }

        // When: Creating PublicKey
        // Then: Should throw exception
        assertFailsWith<IllegalArgumentException> {
            PublicKey(tooShort)
        }
    }

    /**
     * Tests that PublicKey constructor rejects keys longer than
     * 32 bytes to maintain Nostr standard compliance.
     */
    @Test
    fun `constructor rejects key longer than 32 bytes`() {
        // Given: 33-byte array (too long)
        val tooLong = ByteArray(33) { it.toByte() }

        // When: Creating PublicKey
        // Then: Should throw exception
        assertFailsWith<IllegalArgumentException> {
            PublicKey(tooLong)
        }
    }

    /**
     * Tests that toHex converts byte array to lowercase hex string
     * with correct length (64 characters for 32 bytes).
     */
    @Test
    fun `toHex converts bytes to hex string`() {
        // Given: PublicKey with known byte pattern
        val bytes = ByteArray(32) { (it % 16).toByte() }
        val publicKey = PublicKey(bytes)

        // When: Converting to hex
        val hex = publicKey.toHex()

        // Then: Should be 64-character hex string
        assertEquals(64, hex.length)
        assertTrue(hex.all { it in '0'..'9' || it in 'a'..'f' })
    }

    /**
     * Tests that fromHex factory method creates PublicKey from
     * valid hex string, enabling deserialization.
     */
    @Test
    fun `fromHex creates PublicKey from hex string`() {
        // Given: Valid 64-character hex string
        val hex = "0123456789abcdef".repeat(4)

        // When: Creating PublicKey from hex
        val publicKey = PublicKey.fromHex(hex)

        // Then: Should create valid key with correct bytes
        assertEquals(32, publicKey.bytes.size)
        assertEquals(hex, publicKey.toHex())
    }

    /**
     * Tests that fromHex rejects hex strings with incorrect length
     * to prevent creation of invalid keys.
     */
    @Test
    fun `fromHex rejects hex string shorter than 64 characters`() {
        // Given: Hex string too short (63 characters)
        // When: Creating PublicKey from hex
        // Then: Should throw exception
        assertFailsWith<IllegalArgumentException> {
            PublicKey.fromHex("0".repeat(63))
        }
    }

    /**
     * Tests that fromHex rejects hex strings longer than expected
     * to maintain strict validation.
     */
    @Test
    fun `fromHex rejects hex string longer than 64 characters`() {
        // Given: Hex string too long (65 characters)
        // When: Creating PublicKey from hex
        // Then: Should throw exception
        assertFailsWith<IllegalArgumentException> {
            PublicKey.fromHex("0".repeat(65))
        }
    }

    /**
     * Tests that getRawBytes returns defensive copy of internal bytes,
     * preventing external modification of key material.
     */
    @Test
    fun `getRawBytes returns copy of bytes`() {
        // Given: PublicKey with known byte values
        val original = ByteArray(32) { it.toByte() }
        val publicKey = PublicKey(original)

        // When: Getting raw bytes
        val copy = publicKey.getRawBytes()

        // Then: Should be equal but not same reference
        assertContentEquals(original, copy)
        copy[0] = 99.toByte()
        assertEquals(0.toByte(), publicKey.bytes[0])
    }

    /**
     * Tests that rawData provides same functionality as getRawBytes,
     * maintaining API compatibility.
     */
    @Test
    fun `rawData is alias for getRawBytes`() {
        // Given: PublicKey with byte data
        val bytes = ByteArray(32) { it.toByte() }
        val publicKey = PublicKey(bytes)

        // When: Accessing raw data via both methods
        // Then: Should return identical content
        assertContentEquals(publicKey.getRawBytes(), publicKey.rawData())
    }

    /**
     * Tests that length method returns correct key size (32 bytes)
     * for validation and compatibility checks.
     */
    @Test
    fun `length returns 32`() {
        // Given: PublicKey instance
        val publicKey = PublicKey(ByteArray(32))

        // When: Getting length
        val length = publicKey.length()

        // Then: Should be 32 bytes
        assertEquals(32, length)
    }

    /**
     * Tests that equals compares byte content, not object identity,
     * enabling value-based equality for keys.
     */
    @Test
    fun `equals compares byte content`() {
        // Given: Multiple keys with same and different byte content
        val bytes1 = ByteArray(32) { it.toByte() }
        val bytes2 = ByteArray(32) { it.toByte() }
        val differentBytes = ByteArray(32) { (it + 1).toByte() }

        val key1 = PublicKey(bytes1)
        val key2 = PublicKey(bytes2)
        val key3 = PublicKey(differentBytes)

        // When: Comparing keys
        // Then: Same content equals, different content doesn't
        assertEquals(key1, key2)
        assertTrue(key1 != key3)
    }

    /**
     * Tests that hashCode is based on byte content for proper
     * behavior in hash-based collections.
     */
    @Test
    fun `hashCode is based on byte content`() {
        // Given: Two keys with identical byte content
        val bytes1 = ByteArray(32) { it.toByte() }
        val bytes2 = ByteArray(32) { it.toByte() }

        val key1 = PublicKey(bytes1)
        val key2 = PublicKey(bytes2)

        // When: Computing hash codes
        // Then: Should be equal for equal content
        assertEquals(key1.hashCode(), key2.hashCode())
    }

    /**
     * Tests that toString provides debugging information without
     * exposing full key, showing truncated hex representation.
     */
    @Test
    fun `toString shows truncated hex for debugging`() {
        // Given: PublicKey with known byte pattern
        val publicKey = PublicKey(ByteArray(32) { 0xff.toByte() })

        // When: Converting to string
        val string = publicKey.toString()

        // Then: Should contain class name and partial hex
        assertTrue(string.contains("PublicKey"))
        assertTrue(string.contains("ff"))
    }
}
