package cash.imani.identity.crypto

/**
 * Web platform implementation - returns WebCryptoAdapter.
 */
actual fun createCryptoAdapter(): CryptoAdapter = WebCryptoAdapter()
