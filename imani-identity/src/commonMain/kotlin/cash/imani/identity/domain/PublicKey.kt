package cash.imani.identity.domain

import kotlinx.serialization.Serializable

/**
 * Domain type for a Nostr public key.
 *
 * Kotlin Multiplatform adaptation of xyz.tcheeric.identity.domain.PublicKey.
 * This is a thin wrapper around the raw key bytes that adds domain semantics
 * and type safety.
 *
 * INTENTIONAL DIFFERENCES FROM JAVA VERSION:
 * - Uses 32 bytes (x-coordinate only, Nostr standard) matching Java implementation
 * - No nostr-java dependencies (removed fromNostrJava/toNostrJava for KMP)
 *
 * Design: Domain-Driven Design value object
 * - Immutable
 * - Value-based equality
 * - Contains business rules (key length validation)
 *
 * @property bytes Raw public key bytes (32 bytes, x-coordinate only)
 */
@Serializable
data class PublicKey(
    val bytes: ByteArray
) {
    init {
        require(bytes.size == KEY_LENGTH) {
            "Public key must be exactly $KEY_LENGTH bytes, got ${bytes.size}"
        }
    }

    /**
     * Converts the public key to hex string.
     */
    fun toHex(): String = bytes.joinToString("") { "%02x".format(it) }

    /**
     * Gets the raw key bytes.
     *
     * @return Copy of the public key bytes
     */
    fun getRawBytes(): ByteArray = bytes.copyOf()

    /**
     * Gets the raw key bytes (alias for getRawBytes for API compatibility).
     *
     * @return Copy of the public key bytes
     */
    fun rawData(): ByteArray = getRawBytes()

    /**
     * Returns the key length.
     */
    fun length(): Int = bytes.size

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PublicKey) return false
        return bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int {
        return bytes.contentHashCode()
    }

    override fun toString(): String {
        // Show first 8 characters of hex for debugging
        val hex = toHex()
        return "PublicKey{${hex.substring(0, minOf(16, hex.length))}...}"
    }

    companion object {
        const val KEY_LENGTH = 32 // secp256k1 public keys are 32 bytes (x-coordinate only)

        /**
         * Creates a PublicKey from hex string.
         *
         * @param hex Hexadecimal representation of the public key (64 characters)
         * @return Domain PublicKey
         * @throws IllegalArgumentException if hex string is invalid
         */
        fun fromHex(hex: String): PublicKey {
            require(hex.length == KEY_LENGTH * 2) {
                "Hex string must be exactly ${KEY_LENGTH * 2} characters, got ${hex.length}"
            }
            val bytes = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            return PublicKey(bytes)
        }
    }
}
