package cash.imani.voucher.nostr

import org.w3c.dom.events.Event

/**
 * External declarations for browser WebSocket API.
 *
 * Used for direct Nostr relay communication without third-party libraries.
 */
external class WebSocket(url: String) {
    val readyState: Short
    val url: String

    var onopen: ((Event) -> Unit)?
    var onmessage: ((MessageEvent) -> Unit)?
    var onerror: ((Event) -> Unit)?
    var onclose: ((CloseEvent) -> Unit)?

    fun send(data: String)

    fun close(
        code: Short = definedExternally,
        reason: String = definedExternally,
    )

    companion object {
        val CONNECTING: Short // 0
        val OPEN: Short // 1
        val CLOSING: Short // 2
        val CLOSED: Short // 3
    }
}

/**
 * WebSocket message event containing relay response data.
 */
external class MessageEvent : Event {
    val data: Any?
    val origin: String
}

/**
 * WebSocket close event with status code and reason.
 */
external class CloseEvent : Event {
    val code: Short
    val reason: String
    val wasClean: Boolean
}
