package cash.imani.identity.crypto

/**
 * Factory function to create platform-specific CryptoAdapter implementation.
 *
 * Uses Kotlin Multiplatform's expect/actual mechanism to provide
 * the correct implementation for each target platform:
 * - Web: WebCryptoAdapter (Web Crypto API + @noble/secp256k1)
 * - Android: AndroidCryptoAdapter (Keystore + BouncyCastle)
 * - iOS: IosCryptoAdapter (Keychain + CryptoKit)
 */
expect fun createCryptoAdapter(): CryptoAdapter
