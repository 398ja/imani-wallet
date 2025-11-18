package cash.imani.identity.util

/**
 * Bech32 encoding/decoding implementation per BIP-173.
 *
 * Used for Nostr key formats:
 * - nsec1... (private key)
 * - npub1... (public key)
 *
 * Reference: https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki
 */
object Bech32 {
    private const val CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    private val GENERATOR = intArrayOf(0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)

    /**
     * Encodes data into bech32 format.
     *
     * @param hrp Human-readable part (e.g., "npub", "nsec")
     * @param data Data bytes to encode
     * @return Bech32-encoded string
     */
    fun encode(
        hrp: String,
        data: ByteArray,
    ): String {
        require(hrp.isNotEmpty()) { "HRP cannot be empty" }
        require(hrp.all { it.code in 33..126 }) { "HRP contains invalid characters" }
        require(data.isNotEmpty()) { "Data cannot be empty" }

        val values = convertBits(data, 8, 5, true)
        val checksum = createChecksum(hrp, values)
        val combined = values + checksum

        return hrp + "1" + combined.joinToString("") { CHARSET[it].toString() }
    }

    /**
     * Decodes a bech32-encoded string.
     *
     * @param bech32 Bech32-encoded string
     * @return Pair of HRP and decoded data bytes
     * @throws IllegalArgumentException if format is invalid
     */
    fun decode(bech32: String): Pair<String, ByteArray> {
        require(bech32.isNotEmpty()) { "Bech32 string cannot be empty" }
        require(bech32.all { it.code in 33..126 }) { "Invalid characters in bech32 string" }

        val pos = bech32.lastIndexOf('1')
        require(pos >= 1) { "Missing separator '1'" }
        require(pos + 7 <= bech32.length) { "Bech32 string too short" }

        val hrp = bech32.substring(0, pos)
        val dataWithChecksum = bech32.substring(pos + 1)

        // Convert characters to values
        val values =
            dataWithChecksum.map { char ->
                val index = CHARSET.indexOf(char.lowercaseChar())
                require(index >= 0) { "Invalid character in bech32: $char" }
                index
            }.toIntArray()

        // Verify checksum
        require(verifyChecksum(hrp, values)) { "Invalid bech32 checksum" }

        // Remove checksum (last 6 characters)
        val dataValues = values.sliceArray(0 until values.size - 6)

        // Convert from 5-bit to 8-bit
        val data = convertBits(dataValues, 5, 8, false)

        return hrp to ByteArray(data.size) { data[it].toByte() }
    }

    /**
     * Converts data between bit groups.
     *
     * @param data Input data
     * @param fromBits Bits per input value
     * @param toBits Bits per output value
     * @param pad Whether to pad the output
     * @return Converted data
     */
    private fun convertBits(
        data: ByteArray,
        fromBits: Int,
        toBits: Int,
        pad: Boolean,
    ): IntArray {
        return convertBits(data.map { it.toInt() and 0xFF }.toIntArray(), fromBits, toBits, pad)
    }

    private fun convertBits(
        data: IntArray,
        fromBits: Int,
        toBits: Int,
        pad: Boolean,
    ): IntArray {
        var acc = 0
        var bits = 0
        val result = mutableListOf<Int>()
        val maxv = (1 shl toBits) - 1

        for (value in data) {
            acc = (acc shl fromBits) or value
            bits += fromBits

            while (bits >= toBits) {
                bits -= toBits
                result.add((acc shr bits) and maxv)
            }
        }

        if (pad) {
            if (bits > 0) {
                result.add((acc shl (toBits - bits)) and maxv)
            }
        } else {
            require(bits < fromBits) { "Invalid padding in data" }
            require(((acc shl (toBits - bits)) and maxv) == 0) { "Non-zero padding" }
        }

        return result.toIntArray()
    }

    /**
     * Computes the bech32 checksum.
     */
    private fun createChecksum(
        hrp: String,
        values: IntArray,
    ): IntArray {
        val expanded = expandHrp(hrp)
        val combined = expanded + values + IntArray(6)
        val polymod = polymod(combined) xor 1

        return IntArray(6) { i ->
            (polymod shr (5 * (5 - i))) and 31
        }
    }

    /**
     * Verifies the bech32 checksum.
     */
    private fun verifyChecksum(
        hrp: String,
        values: IntArray,
    ): Boolean {
        val expanded = expandHrp(hrp)
        val combined = expanded + values
        return polymod(combined) == 1
    }

    /**
     * Expands the HRP for checksum computation.
     */
    private fun expandHrp(hrp: String): IntArray {
        val result = IntArray(hrp.length * 2 + 1)
        for (i in hrp.indices) {
            result[i] = hrp[i].code shr 5
            result[i + hrp.length + 1] = hrp[i].code and 31
        }
        result[hrp.length] = 0
        return result
    }

    /**
     * Computes the bech32 polymod.
     */
    private fun polymod(values: IntArray): Int {
        var chk = 1
        for (value in values) {
            val top = chk shr 25
            chk = ((chk and 0x1ffffff) shl 5) xor value
            for (i in 0..4) {
                if (((top shr i) and 1) != 0) {
                    chk = chk xor GENERATOR[i]
                }
            }
        }
        return chk
    }

    /**
     * Encodes a public key (32 bytes) to npub format.
     */
    fun encodeNpub(publicKey: ByteArray): String {
        require(publicKey.size == 32) { "Public key must be 32 bytes" }
        return encode("npub", publicKey)
    }

    /**
     * Encodes a private key (32 bytes) to nsec format.
     */
    fun encodeNsec(privateKey: ByteArray): String {
        require(privateKey.size == 32) { "Private key must be 32 bytes" }
        return encode("nsec", privateKey)
    }

    /**
     * Decodes an npub-formatted public key.
     *
     * @return 32-byte public key
     */
    fun decodeNpub(npub: String): ByteArray {
        val (hrp, data) = decode(npub)
        require(hrp == "npub") { "Not an npub key (hrp=$hrp)" }
        require(data.size == 32) { "Invalid npub length: ${data.size}" }
        return data
    }

    /**
     * Decodes an nsec-formatted private key.
     *
     * @return 32-byte private key
     */
    fun decodeNsec(nsec: String): ByteArray {
        val (hrp, data) = decode(nsec)
        require(hrp == "nsec") { "Not an nsec key (hrp=$hrp)" }
        require(data.size == 32) { "Invalid nsec length: ${data.size}" }
        return data
    }
}
