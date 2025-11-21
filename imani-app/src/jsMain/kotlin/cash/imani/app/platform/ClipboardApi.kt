package cash.imani.app.platform

import kotlin.js.Promise

/**
 * External declarations for the Web Clipboard API.
 *
 * References:
 * - https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API
 * - https://developer.mozilla.org/en-US/docs/Web/API/Clipboard
 */
external interface Clipboard {
    fun writeText(text: String): Promise<Unit>
    fun readText(): Promise<String>
}

external interface Navigator {
    val clipboard: Clipboard
}

external val navigator: Navigator
