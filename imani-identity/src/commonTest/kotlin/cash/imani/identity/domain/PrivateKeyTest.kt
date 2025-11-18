package cash.imani.identity.domain

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PrivateKeyTest {

    @Test
    fun `constructor validates key length`() {
        val validBytes = ByteArray(32) { it.toByte() }
        PrivateKey(validBytes) // Should not throw

        val tooShort = ByteArray(31) { it.toByte() }
        assertFailsWith<IllegalArgumentException> {
            PrivateKey(tooShort)
        }

        val tooLong = ByteArray(33) { it.toByte() }
        assertFailsWith<IllegalArgumentException> {
            PrivateKey(tooLong)
        }
    }

    @Test
    fun `toHex converts bytes to hex string`() {
        val bytes = ByteArray(32) { (it % 16).toByte() }
        val privateKey = PrivateKey(bytes)
        val hex = privateKey.toHex()

        assertEquals(64, hex.length)
        assertTrue(hex.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun `fromHex creates PrivateKey from hex string`() {
        val hex = "0123456789abcdef".repeat(4) // 64 chars
        val privateKey = PrivateKey.fromHex(hex)

        assertEquals(32, privateKey.length())
        assertEquals(hex, privateKey.toHex())
    }

    @Test
    fun `fromHex validates hex string length`() {
        assertFailsWith<IllegalArgumentException> {
            PrivateKey.fromHex("0".repeat(63)) // Too short
        }

        assertFailsWith<IllegalArgumentException> {
            PrivateKey.fromHex("0".repeat(65)) // Too long
        }
    }

    @Test
    fun `getRawBytes returns copy of bytes`() {
        val original = ByteArray(32) { it.toByte() }
        val privateKey = PrivateKey(original)
        val copy = privateKey.getRawBytes()

        assertContentEquals(original, copy)
        // Verify it's a copy, not the same array
        copy[0] = 99.toByte()
        // Original key should still have original value (we can't directly access bytes, but toHex should show it)
        assertTrue(privateKey.toHex().startsWith("00"))
    }

    @Test
    fun `rawData is alias for getRawBytes`() {
        val bytes = ByteArray(32) { it.toByte() }
        val privateKey = PrivateKey(bytes)

        assertContentEquals(privateKey.getRawBytes(), privateKey.rawData())
    }

    @Test
    fun `length returns 32`() {
        val privateKey = PrivateKey(ByteArray(32))
        assertEquals(32, privateKey.length())
    }

    @Test
    fun `clear zeros out the key bytes`() {
        val bytes = ByteArray(32) { 0xff.toByte() }
        val privateKey = PrivateKey(bytes)

        // Key should have non-zero bytes initially
        assertTrue(privateKey.toHex().contains("ff"))

        privateKey.clear()

        // After clear, all bytes should be zero
        assertEquals("0".repeat(64), privateKey.toHex())
    }

    @Test
    fun `toString never exposes the key`() {
        val privateKey = PrivateKey(ByteArray(32) { 0xff.toByte() })
        val string = privateKey.toString()

        assertTrue(string.contains("PrivateKey"))
        assertFalse(string.contains("ff".repeat(10))) // Should not contain actual key bytes
    }

    @Test
    fun `equals compares byte content`() {
        val bytes1 = ByteArray(32) { it.toByte() }
        val bytes2 = ByteArray(32) { it.toByte() }
        val differentBytes = ByteArray(32) { (it + 1).toByte() }

        val key1 = PrivateKey(bytes1)
        val key2 = PrivateKey(bytes2)
        val key3 = PrivateKey(differentBytes)

        assertEquals(key1, key2)
        assertTrue(key1 != key3)
    }

    @Test
    fun `hashCode is based on byte content`() {
        val bytes1 = ByteArray(32) { it.toByte() }
        val bytes2 = ByteArray(32) { it.toByte() }

        val key1 = PrivateKey(bytes1)
        val key2 = PrivateKey(bytes2)

        assertEquals(key1.hashCode(), key2.hashCode())
    }
}
