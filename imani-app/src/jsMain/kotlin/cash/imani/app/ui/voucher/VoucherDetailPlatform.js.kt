package cash.imani.app.ui.voucher

import kotlinx.browser.window

/**
 * Copies text to clipboard using Web Clipboard API.
 */
actual fun copyToClipboard(text: String) {
    window.navigator.clipboard.writeText(text)
    println("[VoucherDetail] Copied to clipboard: ${text.take(20)}...")
}

/**
 * Shares text via Web Share API (if available) or falls back to clipboard.
 */
actual fun shareViaSystem(text: String) {
    val navigator = window.navigator.asDynamic()

    if (navigator.share != undefined) {
        val shareData = js("{}")
        shareData.text = text
        shareData.title = "Imani Voucher"

        navigator.share(shareData).catch { error: dynamic ->
            println("[VoucherDetail] Share failed: $error, falling back to clipboard")
            copyToClipboard(text)
        }
    } else {
        // Fallback to clipboard
        println("[VoucherDetail] Web Share API not available, using clipboard")
        copyToClipboard(text)
    }
}
