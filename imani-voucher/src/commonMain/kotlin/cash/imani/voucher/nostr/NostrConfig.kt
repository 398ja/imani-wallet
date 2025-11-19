package cash.imani.voucher.nostr

/**
 * Gets an environment variable value.
 * Platform-specific implementation via expect/actual pattern.
 */
expect fun getEnvironmentVariable(name: String): String?

/**
 * Nostr relay configuration for Imani Wallet.
 *
 * Provides default relay URLs and configuration options for voucher storage.
 */
object NostrConfig {
    /**
     * Local relay for development and testing.
     *
     * Use this to avoid publishing test vouchers to public relays.
     * Start a local relay with: nostr-rs-relay or knostr on ws://localhost:5555
     */
    val LOCAL_RELAY =
        listOf(
            "ws://localhost:5555",
        )

    /**
     * Default Nostr relays for production voucher storage.
     *
     * These relays are well-established, reliable, and have good uptime.
     * Users can override these with their preferred relays.
     *
     * WARNING: These are public relays. Use LOCAL_RELAY for testing!
     */
    val PRODUCTION_RELAYS =
        listOf(
            // Popular iOS client relay
            "wss://relay.damus.io",
            // Popular web client relay
            "wss://relay.snort.social",
            // General purpose relay
            "wss://nos.lol",
            // Relay with search capabilities
            "wss://relay.nostr.band",
        )

    /**
     * Default relays based on build configuration.
     *
     * - Development: Uses LOCAL_RELAY (ws://localhost:5555)
     * - Production: Uses PRODUCTION_RELAYS (public relays)
     *
     * Override by setting IMANI_NOSTR_ENV environment variable:
     * - "local" or "dev": Use LOCAL_RELAY
     * - "production" or "prod": Use PRODUCTION_RELAYS
     */
    val DEFAULT_RELAYS: List<String>
        get() {
            val env = getEnvironmentVariable("IMANI_NOSTR_ENV")?.lowercase()
            return when (env) {
                "production", "prod" -> PRODUCTION_RELAYS
                else -> LOCAL_RELAY // Default to local for safety
            }
        }

    /**
     * Test relays for unit tests (same as LOCAL_RELAY).
     */
    val TEST_RELAYS = LOCAL_RELAY

    /**
     * Query timeout in milliseconds.
     *
     * Maximum time to wait for relay responses when querying events.
     */
    const val QUERY_TIMEOUT_MS = 3000L

    /**
     * Connection timeout in milliseconds.
     *
     * Maximum time to wait when establishing relay connections.
     */
    const val CONNECTION_TIMEOUT_MS = 5000L

    /**
     * Maximum number of events to return per query.
     *
     * Prevents excessive data transfer and processing.
     */
    const val MAX_QUERY_LIMIT = 100
}
