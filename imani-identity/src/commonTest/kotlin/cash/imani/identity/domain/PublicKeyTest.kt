package cash.imani.identity.domain

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class PublicKeyTest {

    @Test
    fun `constructor validates key length`() {
        val validBytes = ByteArray(32) { it.toByte() }
        PublicKey(validBytes) // Should not throw

        val tooShort = ByteArray(31) { it.toByte() }
        assertFailsWith<IllegalArgumentException> {
            PublicKey(tooShort)
        }

        val tooLong = ByteArray(33) { it.toByte() }
        assertFailsWith<IllegalArgumentException> {
            PublicKey(tooLong)
        }
    }

    @Test
    fun `toHex converts bytes to hex string`() {
        val bytes = ByteArray(32) { (it % 16).toByte() }
        val publicKey = PublicKey(bytes)
        val hex = publicKey.toHex()

        assertEquals(64, hex.length)
        assertTrue(hex.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun `fromHex creates PublicKey from hex string`() {
        val hex = "0123456789abcdef".repeat(4) // 64 chars
        val publicKey = PublicKey.fromHex(hex)

        assertEquals(32, publicKey.bytes.size)
        assertEquals(hex, publicKey.toHex())
    }

    @Test
    fun `fromHex validates hex string length`() {
        assertFailsWith<IllegalArgumentException> {
            PublicKey.fromHex("0".repeat(63)) // Too short
        }

        assertFailsWith<IllegalArgumentException> {
            PublicKey.fromHex("0".repeat(65)) // Too long
        }
    }

    @Test
    fun `getRawBytes returns copy of bytes`() {
        val original = ByteArray(32) { it.toByte() }
        val publicKey = PublicKey(original)
        val copy = publicKey.getRawBytes()

        assertContentEquals(original, copy)
        // Verify it's a copy, not the same array
        copy[0] = 99.toByte()
        assertEquals(0.toByte(), publicKey.bytes[0])
    }

    @Test
    fun `rawData is alias for getRawBytes`() {
        val bytes = ByteArray(32) { it.toByte() }
        val publicKey = PublicKey(bytes)

        assertContentEquals(publicKey.getRawBytes(), publicKey.rawData())
    }

    @Test
    fun `length returns 32`() {
        val publicKey = PublicKey(ByteArray(32))
        assertEquals(32, publicKey.length())
    }

    @Test
    fun `equals compares byte content`() {
        val bytes1 = ByteArray(32) { it.toByte() }
        val bytes2 = ByteArray(32) { it.toByte() }
        val differentBytes = ByteArray(32) { (it + 1).toByte() }

        val key1 = PublicKey(bytes1)
        val key2 = PublicKey(bytes2)
        val key3 = PublicKey(differentBytes)

        assertEquals(key1, key2)
        assertTrue(key1 != key3)
    }

    @Test
    fun `hashCode is based on byte content`() {
        val bytes1 = ByteArray(32) { it.toByte() }
        val bytes2 = ByteArray(32) { it.toByte() }

        val key1 = PublicKey(bytes1)
        val key2 = PublicKey(bytes2)

        assertEquals(key1.hashCode(), key2.hashCode())
    }

    @Test
    fun `toString shows truncated hex for debugging`() {
        val publicKey = PublicKey(ByteArray(32) { 0xff.toByte() })
        val string = publicKey.toString()

        assertTrue(string.contains("PublicKey"))
        assertTrue(string.contains("ff"))
    }
}
