package cash.imani.identity.domain

import kotlinx.serialization.Serializable

/**
 * Domain type for a Nostr private key.
 *
 * Kotlin Multiplatform adaptation of xyz.tcheeric.identity.domain.PrivateKey.
 * This is a thin wrapper around the raw key bytes that adds domain semantics
 * and type safety.
 *
 * WARNING: Private keys should never be serialized unencrypted.
 * This class is marked Serializable for internal use only with proper encryption.
 *
 * INTENTIONAL DIFFERENCES FROM JAVA VERSION:
 * - No nostr-java dependencies (removed fromNostrJava/toNostrJava for KMP)
 * - clear() fills with zeros (matches Java behavior)
 *
 * Design: Domain-Driven Design value object
 * - Immutable (conceptually - bytes can be cleared for security)
 * - Value-based equality
 * - Contains business rules (key length validation)
 *
 * @property bytes Raw private key bytes (32 bytes for secp256k1)
 */
@Serializable
data class PrivateKey(
    private val bytes: ByteArray
) {
    init {
        require(bytes.size == KEY_LENGTH) {
            "Private key must be exactly $KEY_LENGTH bytes, got ${bytes.size}"
        }
    }

    /**
     * Converts the private key to hex string.
     * SECURITY WARNING: This exposes the private key. Use only when necessary.
     */
    fun toHex(): String = bytes.joinToString("") { "%02x".format(it) }

    /**
     * Gets the raw key bytes.
     * SECURITY WARNING: The returned array is a copy to prevent mutation.
     * Callers should clear the array after use.
     *
     * @return Copy of the private key bytes
     */
    fun getRawBytes(): ByteArray = bytes.copyOf()

    /**
     * Gets the raw key bytes (alias for getRawBytes for API compatibility).
     * SECURITY WARNING: The returned array is a copy to prevent mutation.
     * Callers should clear the array after use.
     *
     * @return Copy of the private key bytes
     */
    fun rawData(): ByteArray = getRawBytes()

    /**
     * Returns the key length.
     */
    fun length(): Int = bytes.size

    /**
     * Securely clears the private key from memory.
     * Call this when the key is no longer needed.
     */
    fun clear() {
        bytes.fill(0)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PrivateKey) return false
        return bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int {
        return bytes.contentHashCode()
    }

    override fun toString(): String {
        // Never expose the actual key in toString for security
        return "PrivateKey{length=${bytes.size}, hash=${hashCode().toString(16)}}"
    }

    companion object {
        const val KEY_LENGTH = 32 // secp256k1 requires exactly 32 bytes

        /**
         * Creates a PrivateKey from hex string.
         *
         * @param hex Hexadecimal representation of the private key (64 characters)
         * @return Domain PrivateKey
         * @throws IllegalArgumentException if hex string is invalid
         */
        fun fromHex(hex: String): PrivateKey {
            require(hex.length == KEY_LENGTH * 2) {
                "Hex string must be exactly ${KEY_LENGTH * 2} characters, got ${hex.length}"
            }
            val bytes = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
            return PrivateKey(bytes)
        }
    }
}
