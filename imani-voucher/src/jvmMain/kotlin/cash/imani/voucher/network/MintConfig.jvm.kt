package cash.imani.voucher.network

/**
 * JVM implementation of mint environment variable access.
 *
 * Reads from System.getenv().
 */
actual fun getMintEnvironmentVariable(name: String): String? {
    return System.getenv(name)
}
