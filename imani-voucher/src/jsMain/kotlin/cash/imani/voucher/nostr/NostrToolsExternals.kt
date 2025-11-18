package cash.imani.voucher.nostr

import kotlin.js.Promise

/**
 * External declarations for the nostr-tools library.
 *
 * This allows Kotlin/JS to interact with the JavaScript nostr-tools library.
 *
 * NPM Package: nostr-tools
 * Version: ^2.1.0
 * Documentation: https://github.com/nbd-wtf/nostr-tools
 *
 * Add to package.json:
 * ```json
 * {
 *   "dependencies": {
 *     "nostr-tools": "^2.1.0"
 *   }
 * }
 * ```
 */

/**
 * Simple relay pool for publishing and querying events.
 */
@JsModule("nostr-tools")
@JsNonModule
external class SimplePool {
    /**
     * Publishes an event to specified relays.
     *
     * @param relays Array of relay URLs
     * @param event The event to publish
     * @return Promise that resolves when published
     */
    fun publish(
        relays: Array<String>,
        event: dynamic,
    ): Promise<Unit>

    /**
     * Queries events from relays synchronously.
     *
     * @param relays Array of relay URLs
     * @param filters Array of event filters
     * @return Array of matching events
     */
    fun querySync(
        relays: Array<String>,
        filters: Array<dynamic>,
    ): Array<dynamic>

    /**
     * Subscribes to events from relays.
     *
     * @param relays Array of relay URLs
     * @param filters Array of event filters
     * @param callbacks Object with onEvent and onEose callbacks
     * @return Subscription object with close() method
     */
    fun subscribeMany(
        relays: Array<String>,
        filters: Array<dynamic>,
        callbacks: dynamic,
    ): dynamic

    /**
     * Closes all relay connections.
     */
    fun close(relays: Array<String>)
}

/**
 * Event utilities from nostr-tools.
 */
@JsModule("nostr-tools")
@JsNonModule
external object Events {
    /**
     * Generates an event ID from event data.
     *
     * @param event Event object
     * @return Event ID (hex string)
     */
    fun getEventHash(event: dynamic): String

    /**
     * Signs an event with a private key.
     *
     * @param event Event object
     * @param privateKey Private key (hex string)
     * @return Signed event with id and sig fields
     */
    fun finishEvent(
        event: dynamic,
        privateKey: String,
    ): dynamic

    /**
     * Verifies an event signature.
     *
     * @param event Event object with sig field
     * @return true if signature is valid
     */
    fun verifySignature(event: dynamic): Boolean
}

/**
 * Key generation utilities from nostr-tools.
 */
@JsModule("nostr-tools")
@JsNonModule
external object Keys {
    /**
     * Generates a new private key.
     *
     * @return Private key (hex string)
     */
    fun generatePrivateKey(): String

    /**
     * Derives public key from private key.
     *
     * @param privateKey Private key (hex string)
     * @return Public key (hex string)
     */
    fun getPublicKey(privateKey: String): String
}

/**
 * Relay management utilities.
 */
@JsModule("nostr-tools")
@JsNonModule
external object Relay {
    /**
     * Connects to a single relay.
     *
     * @param url Relay URL
     * @return Relay connection object
     */
    fun relayInit(url: String): dynamic
}
