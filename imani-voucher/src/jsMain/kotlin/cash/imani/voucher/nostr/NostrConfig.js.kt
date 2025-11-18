package cash.imani.voucher.nostr

/**
 * JS implementation of environment variable access.
 *
 * Browser environment: Always returns null (no environment variables in browser)
 * Node.js environment: Could read from process.env, but not implemented for Phase 2
 *
 * For JS, relay configuration should be done via:
 * - Build-time configuration
 * - Runtime application settings
 * - LocalStorage/IndexedDB preferences
 */
actual fun getEnvironmentVariable(name: String): String? {
    // Browser doesn't have environment variables
    // Node.js has process.env, but we're targeting browser for Phase 2
    return null
}
