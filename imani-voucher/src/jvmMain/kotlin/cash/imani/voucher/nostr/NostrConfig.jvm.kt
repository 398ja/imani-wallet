package cash.imani.voucher.nostr

/**
 * JVM implementation of environment variable access.
 *
 * Reads from System.getenv().
 */
actual fun getEnvironmentVariable(name: String): String? {
    return System.getenv(name)
}
