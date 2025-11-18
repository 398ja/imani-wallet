package cash.imani.identity.util

/**
 * Converts a hex string to a ByteArray.
 *
 * @throws IllegalArgumentException if the string is not valid hex
 */
fun String.hexToBytes(): ByteArray {
    require(length % 2 == 0) { "Hex string must have even length" }
    return chunked(2)
        .map { it.toInt(16).toByte() }
        .toByteArray()
}

/**
 * Converts a ByteArray to a hex string.
 */
fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

/**
 * Validates if a string is valid hex.
 */
fun String.isValidHex(): Boolean {
    return all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' } && length % 2 == 0
}
