package cash.imani.identity.crypto

/**
 * JVM platform implementation - returns JvmCryptoAdapter.
 *
 * Note: This is a placeholder implementation for Phase 0/1.
 * Full JVM implementation with BouncyCastle will be added in Phase 2+
 * when server-side operations are required.
 */
actual fun createCryptoAdapter(): CryptoAdapter = JvmCryptoAdapter()
