package cash.imani.app.ui.utils

import kotlinx.browser.window

/**
 * Copies text to the system clipboard using the Web Clipboard API.
 *
 * @param text The text to copy
 * @return true if successful, false otherwise
 */
actual suspend fun copyToClipboard(text: String): Boolean {
    return try {
        window.navigator.clipboard.writeText(text)
        true
    } catch (e: Exception) {
        console.error("Failed to copy to clipboard", e)
        false
    }
}
