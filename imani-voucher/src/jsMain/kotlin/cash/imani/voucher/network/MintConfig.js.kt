package cash.imani.voucher.network

/**
 * JS implementation of mint environment variable access.
 *
 * Browser environment: Always returns null (no environment variables in browser)
 * Node.js environment: Could read from process.env, but not implemented for Phase 2
 *
 * For JS, mint configuration should be done via:
 * - Build-time configuration
 * - Runtime application settings
 * - LocalStorage/IndexedDB preferences
 */
actual fun getMintEnvironmentVariable(name: String): String? {
    // Browser doesn't have environment variables
    // Defaults to LOCAL_MINT for safety
    return null
}
