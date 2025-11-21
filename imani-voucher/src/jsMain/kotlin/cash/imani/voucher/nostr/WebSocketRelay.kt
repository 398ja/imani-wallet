package cash.imani.voucher.nostr

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * WebSocket-based Nostr relay connection.
 *
 * Implements NIP-01 protocol for publishing and querying events.
 * Each instance manages a single relay connection.
 */
class WebSocketRelay(private val url: String) {
    private var ws: WebSocket? = null
    private var isConnected = false

    private val pendingSubscriptions = mutableMapOf<String, (List<NostrEvent>) -> Unit>()
    private val subscriptionEvents = mutableMapOf<String, MutableList<NostrEvent>>()
    private val pendingPublishes = mutableMapOf<String, (Boolean, String) -> Unit>()

    /**
     * Connect to the relay.
     */
    suspend fun connect(): Result<Unit> =
        runCatching {
            if (isConnected) return@runCatching

            suspendCancellableCoroutine { cont ->
                val socket = WebSocket(url)

                socket.onopen = {
                    console.log("[WebSocketRelay] Connected to $url")
                    isConnected = true
                    ws = socket
                    cont.resume(Unit)
                }

                socket.onerror = { event ->
                    console.error("[WebSocketRelay] Error connecting to $url")
                    if (!isConnected) {
                        cont.resumeWithException(Exception("Failed to connect to $url"))
                    }
                }

                socket.onclose = { event ->
                    console.log("[WebSocketRelay] Disconnected from $url: ${event.reason}")
                    isConnected = false
                    ws = null
                }

                socket.onmessage = { event ->
                    handleMessage(event.data as String)
                }

                cont.invokeOnCancellation {
                    socket.close()
                }
            }
        }

    /**
     * Publish an event to the relay.
     *
     * @param event The signed Nostr event to publish
     * @return Result with success/failure
     */
    suspend fun publish(event: NostrEvent): Result<Unit> =
        runCatching {
            requireConnected()

            val eventId = event.id ?: throw IllegalArgumentException("Event must have an ID")

            withTimeoutOrNull(5000L) {
                suspendCancellableCoroutine { cont ->
                    pendingPublishes[eventId] = { ok, message ->
                        if (ok) {
                            cont.resume(Unit)
                        } else {
                            cont.resumeWithException(Exception("Publish rejected: $message"))
                        }
                    }

                    // Send EVENT message: ["EVENT", <event>]
                    val message =
                        buildJsonArray {
                            add(JsonPrimitive("EVENT"))
                            add(event.toJsonObject())
                        }.toString()

                    ws?.send(message)
                    console.log("[WebSocketRelay] Published event $eventId to $url")
                }
            } ?: throw Exception("Publish timeout for event $eventId")
        }

    /**
     * Query events from the relay.
     *
     * @param filter NIP-01 filter for querying events
     * @param timeoutMs Timeout in milliseconds
     * @return List of matching events
     */
    suspend fun query(
        filter: NostrFilter,
        timeoutMs: Long = 3000L,
    ): Result<List<NostrEvent>> =
        runCatching {
            requireConnected()

            val subId = "sub_${kotlin.random.Random.nextInt(100000, 999999)}"

            withTimeoutOrNull(timeoutMs) {
                suspendCancellableCoroutine { cont ->
                    subscriptionEvents[subId] = mutableListOf()

                    pendingSubscriptions[subId] = { events ->
                        cont.resume(events)
                    }

                    // Send REQ message: ["REQ", <subId>, <filter>]
                    val message =
                        buildJsonArray {
                            add(JsonPrimitive("REQ"))
                            add(JsonPrimitive(subId))
                            add(filter.toJsonObject())
                        }.toString()

                    ws?.send(message)
                    console.log("[WebSocketRelay] Sent query $subId to $url")

                    cont.invokeOnCancellation {
                        closeSubscription(subId)
                    }
                }
            } ?: emptyList()
        }

    /**
     * Close a subscription.
     */
    private fun closeSubscription(subId: String) {
        if (!isConnected) return

        val message =
            buildJsonArray {
                add(JsonPrimitive("CLOSE"))
                add(JsonPrimitive(subId))
            }.toString()

        ws?.send(message)
        pendingSubscriptions.remove(subId)
        subscriptionEvents.remove(subId)
    }

    /**
     * Handle incoming messages from relay.
     */
    private fun handleMessage(data: String) {
        try {
            val json = Json.parseToJsonElement(data).jsonArray
            val type = json[0].jsonPrimitive.content

            when (type) {
                "EVENT" -> handleEventMessage(json)
                "OK" -> handleOkMessage(json)
                "EOSE" -> handleEoseMessage(json)
                "NOTICE" -> handleNoticeMessage(json)
                else -> console.log("[WebSocketRelay] Unknown message type: $type")
            }
        } catch (e: Exception) {
            console.error("[WebSocketRelay] Error parsing message: ${e.message}")
        }
    }

    /**
     * Handle EVENT message: ["EVENT", <subId>, <event>]
     */
    private fun handleEventMessage(json: JsonArray) {
        val subId = json[1].jsonPrimitive.content
        val eventJson = json[2]

        val event = NostrEvent.fromJsonElement(eventJson)
        subscriptionEvents[subId]?.add(event)
    }

    /**
     * Handle OK message: ["OK", <eventId>, <success>, <message>]
     */
    private fun handleOkMessage(json: JsonArray) {
        val eventId = json[1].jsonPrimitive.content
        val success = json[2].jsonPrimitive.content.toBoolean()
        val message = if (json.size > 3) json[3].jsonPrimitive.content else ""

        pendingPublishes.remove(eventId)?.invoke(success, message)
    }

    /**
     * Handle EOSE (End of Stored Events) message: ["EOSE", <subId>]
     */
    private fun handleEoseMessage(json: JsonArray) {
        val subId = json[1].jsonPrimitive.content
        val events = subscriptionEvents[subId]?.toList() ?: emptyList()

        console.log("[WebSocketRelay] EOSE for $subId: ${events.size} events")

        pendingSubscriptions.remove(subId)?.invoke(events)
        closeSubscription(subId)
    }

    /**
     * Handle NOTICE message: ["NOTICE", <message>]
     */
    private fun handleNoticeMessage(json: JsonArray) {
        val message = json[1].jsonPrimitive.content
        console.log("[WebSocketRelay] NOTICE from $url: $message")
    }

    /**
     * Close the WebSocket connection.
     */
    fun close() {
        ws?.close()
        ws = null
        isConnected = false
        pendingSubscriptions.clear()
        subscriptionEvents.clear()
        pendingPublishes.clear()
    }

    private fun requireConnected() {
        if (!isConnected || ws == null) {
            throw IllegalStateException("Not connected to relay $url")
        }
    }
}
