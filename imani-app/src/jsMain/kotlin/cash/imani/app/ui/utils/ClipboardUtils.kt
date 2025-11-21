package cash.imani.app.ui.utils

import cash.imani.app.platform.navigator
import kotlinx.browser.document
import kotlinx.coroutines.await
import org.w3c.dom.HTMLTextAreaElement

/**
 * Copies text to the system clipboard using the Web Clipboard API.
 *
 * Tries modern Clipboard API first, falls back to legacy document.execCommand.
 *
 * @param text The text to copy
 * @return true if successful, false otherwise
 */
actual suspend fun copyToClipboard(text: String): Boolean {
    return try {
        // Try modern Clipboard API (requires secure context)
        navigator.clipboard.writeText(text).await()
        console.log("Copied to clipboard using Clipboard API: ${text.take(20)}...")
        true
    } catch (e: Exception) {
        console.warn("Clipboard API failed, trying fallback", e)
        // Fallback to legacy method for HTTP or older browsers
        try {
            copyToClipboardLegacy(text)
        } catch (e2: Exception) {
            console.error("Both clipboard methods failed", e2)
            false
        }
    }
}

/**
 * Legacy clipboard copy using document.execCommand (deprecated but works on HTTP).
 *
 * Creates a temporary textarea, selects it, copies, and removes it.
 */
private fun copyToClipboardLegacy(text: String): Boolean {
    val textarea = document.createElement("textarea") as HTMLTextAreaElement
    textarea.value = text
    textarea.style.position = "fixed"
    textarea.style.left = "-9999px"
    textarea.style.top = "-9999px"
    document.body?.appendChild(textarea)

    textarea.select()
    textarea.setSelectionRange(0, text.length)

    val successful = document.execCommand("copy")
    document.body?.removeChild(textarea)

    if (successful) {
        console.log("Copied to clipboard using legacy method: ${text.take(20)}...")
    }

    return successful
}
