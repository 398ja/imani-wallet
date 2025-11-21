package cash.imani.app.ui.voucher

import platform.UIKit.UIPasteboard
import platform.UIKit.UIActivityViewController
import platform.UIKit.UIApplication

/**
 * Copies text to clipboard using iOS UIPasteboard.
 */
actual fun copyToClipboard(text: String) {
    UIPasteboard.generalPasteboard.string = text
    println("[VoucherDetail] Copied to clipboard: ${text.take(20)}...")
}

/**
 * Shares text via iOS share sheet.
 */
actual fun shareViaSystem(text: String) {
    val activityItems = listOf(text)
    val activityController = UIActivityViewController(
        activityItems = activityItems,
        applicationActivities = null,
    )

    val rootViewController = UIApplication.sharedApplication.keyWindow?.rootViewController
    rootViewController?.presentViewController(
        activityController,
        animated = true,
        completion = null,
    )
}
