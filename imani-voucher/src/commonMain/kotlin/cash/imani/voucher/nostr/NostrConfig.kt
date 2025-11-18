package cash.imani.voucher.nostr

/**
 * Nostr relay configuration for Imani Wallet.
 *
 * Provides default relay URLs and configuration options for voucher storage.
 */
object NostrConfig {
    /**
     * Default Nostr relays for voucher storage.
     *
     * These relays are well-established, reliable, and have good uptime.
     * Users can override these with their preferred relays.
     */
    val DEFAULT_RELAYS = listOf(
        "wss://relay.damus.io",      // Popular iOS client relay
        "wss://relay.snort.social",  // Popular web client relay
        "wss://nos.lol",             // General purpose relay
        "wss://relay.nostr.band"     // Relay with search capabilities
    )

    /**
     * Test relays for development and testing.
     *
     * These may have lower reliability but are useful for testing.
     */
    val TEST_RELAYS = listOf(
        "wss://relay.damus.io",
        "wss://relay.snort.social"
    )

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
