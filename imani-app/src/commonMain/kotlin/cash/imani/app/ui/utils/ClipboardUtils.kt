package cash.imani.app.ui.utils

/**
 * Copies text to the system clipboard.
 *
 * This is an expect/actual function for platform-specific clipboard implementation:
 * - JS/Web: Uses Web Clipboard API (navigator.clipboard)
 * - Android: Uses ClipboardManager
 * - iOS: Uses UIPasteboard
 *
 * @param text The text to copy
 * @return true if successful, false otherwise
 */
expect suspend fun copyToClipboard(text: String): Boolean
