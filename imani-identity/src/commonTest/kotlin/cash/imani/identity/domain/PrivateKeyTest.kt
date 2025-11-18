package cash.imani.identity.domain

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for PrivateKey domain model.
 * Tests validation, hex conversion, security features, and defensive copying.
 */
class PrivateKeyTest {
    /**
     * Tests that PrivateKey constructor accepts valid 32-byte key
     * per secp256k1 standard.
     */
    @Test
    fun `constructor accepts valid 32-byte key`() {
        // Given: Valid 32-byte array
        val validBytes = ByteArray(32) { it.toByte() }

        // When: Creating PrivateKey
        val privateKey = PrivateKey(validBytes)

        // Then: Should not throw (implicit by successful creation)
        assertEquals(32, privateKey.length())
    }

    /**
     * Tests that PrivateKey constructor rejects keys shorter than
     * 32 bytes to ensure cryptographic validity.
     */
    @Test
    fun `constructor rejects key shorter than 32 bytes`() {
        // Given: 31-byte array (too short)
        val tooShort = ByteArray(31) { it.toByte() }

        // When: Creating PrivateKey
        // Then: Should throw exception
        assertFailsWith<IllegalArgumentException> {
            PrivateKey(tooShort)
        }
    }

    /**
     * Tests that PrivateKey constructor rejects keys longer than
     * 32 bytes to maintain secp256k1 standard compliance.
     */
    @Test
    fun `constructor rejects key longer than 32 bytes`() {
        // Given: 33-byte array (too long)
        val tooLong = ByteArray(33) { it.toByte() }

        // When: Creating PrivateKey
        // Then: Should throw exception
        assertFailsWith<IllegalArgumentException> {
            PrivateKey(tooLong)
        }
    }

    /**
     * Tests that toHex converts byte array to lowercase hex string
     * with correct length (64 characters for 32 bytes).
     */
    @Test
    fun `toHex converts bytes to hex string`() {
        // Given: PrivateKey with known byte pattern
        val bytes = ByteArray(32) { (it % 16).toByte() }
        val privateKey = PrivateKey(bytes)

        // When: Converting to hex
        val hex = privateKey.toHex()

        // Then: Should be 64-character hex string
        assertEquals(64, hex.length)
        assertTrue(hex.all { it in '0'..'9' || it in 'a'..'f' })
    }

    /**
     * Tests that fromHex factory method creates PrivateKey from
     * valid hex string, enabling deserialization.
     */
    @Test
    fun `fromHex creates PrivateKey from hex string`() {
        // Given: Valid 64-character hex string
        val hex = "0123456789abcdef".repeat(4)

        // When: Creating PrivateKey from hex
        val privateKey = PrivateKey.fromHex(hex)

        // Then: Should create valid key with correct bytes
        assertEquals(32, privateKey.length())
        assertEquals(hex, privateKey.toHex())
    }

    /**
     * Tests that fromHex rejects hex strings with incorrect length
     * to prevent creation of invalid keys.
     */
    @Test
    fun `fromHex rejects hex string shorter than 64 characters`() {
        // Given: Hex string too short (63 characters)
        // When: Creating PrivateKey from hex
        // Then: Should throw exception
        assertFailsWith<IllegalArgumentException> {
            PrivateKey.fromHex("0".repeat(63))
        }
    }

    /**
     * Tests that fromHex rejects hex strings longer than expected
     * to maintain strict validation.
     */
    @Test
    fun `fromHex rejects hex string longer than 64 characters`() {
        // Given: Hex string too long (65 characters)
        // When: Creating PrivateKey from hex
        // Then: Should throw exception
        assertFailsWith<IllegalArgumentException> {
            PrivateKey.fromHex("0".repeat(65))
        }
    }

    /**
     * Tests that getRawBytes returns defensive copy of internal bytes,
     * preventing external modification of sensitive key material.
     */
    @Test
    fun `getRawBytes returns copy of bytes`() {
        // Given: PrivateKey with known byte values
        val original = ByteArray(32) { it.toByte() }
        val privateKey = PrivateKey(original)

        // When: Getting raw bytes
        val copy = privateKey.getRawBytes()

        // Then: Should be equal but not same reference
        assertContentEquals(original, copy)
        copy[0] = 99.toByte()
        assertTrue(privateKey.toHex().startsWith("00"))
    }

    /**
     * Tests that rawData provides same functionality as getRawBytes,
     * maintaining API compatibility.
     */
    @Test
    fun `rawData is alias for getRawBytes`() {
        // Given: PrivateKey with byte data
        val bytes = ByteArray(32) { it.toByte() }
        val privateKey = PrivateKey(bytes)

        // When: Accessing raw data via both methods
        // Then: Should return identical content
        assertContentEquals(privateKey.getRawBytes(), privateKey.rawData())
    }

    /**
     * Tests that length method returns correct key size (32 bytes)
     * for validation and compatibility checks.
     */
    @Test
    fun `length returns 32`() {
        // Given: PrivateKey instance
        val privateKey = PrivateKey(ByteArray(32))

        // When: Getting length
        val length = privateKey.length()

        // Then: Should be 32 bytes
        assertEquals(32, length)
    }

    /**
     * Tests that clear method zeros out key bytes for security,
     * preventing key material from remaining in memory.
     */
    @Test
    fun `clear zeros out the key bytes`() {
        // Given: PrivateKey with non-zero bytes
        val bytes = ByteArray(32) { 0xff.toByte() }
        val privateKey = PrivateKey(bytes)
        assertTrue(privateKey.toHex().contains("ff"))

        // When: Clearing the key
        privateKey.clear()

        // Then: All bytes should be zero
        assertEquals("0".repeat(64), privateKey.toHex())
    }

    /**
     * Tests that toString never exposes actual key material,
     * providing safe debug output for sensitive data.
     */
    @Test
    fun `toString never exposes the key`() {
        // Given: PrivateKey with known byte pattern
        val privateKey = PrivateKey(ByteArray(32) { 0xff.toByte() })

        // When: Converting to string
        val string = privateKey.toString()

        // Then: Should contain class name but not full key
        assertTrue(string.contains("PrivateKey"))
        assertFalse(string.contains("ff".repeat(10)))
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

        val key1 = PrivateKey(bytes1)
        val key2 = PrivateKey(bytes2)
        val key3 = PrivateKey(differentBytes)

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

        val key1 = PrivateKey(bytes1)
        val key2 = PrivateKey(bytes2)

        // When: Computing hash codes
        // Then: Should be equal for equal content
        assertEquals(key1.hashCode(), key2.hashCode())
    }
}
