package cash.imani.app.ui.voucher

import java.awt.Toolkit
import java.awt.datatransfer.StringSelection

/**
 * Copies text to clipboard using AWT Toolkit.
 */
actual fun copyToClipboard(text: String) {
    try {
        val clipboard = Toolkit.getDefaultToolkit().systemClipboard
        clipboard.setContents(StringSelection(text), null)
        println("[VoucherDetail] Copied to clipboard: ${text.take(20)}...")
    } catch (e: Exception) {
        println("[VoucherDetail] Failed to copy to clipboard: ${e.message}")
    }
}

/**
 * Shares text via system (JVM desktop - just copies to clipboard).
 */
actual fun shareViaSystem(text: String) {
    // On JVM desktop, there's no native share sheet
    // Just copy to clipboard
    println("[VoucherDetail] JVM share - copying to clipboard")
    copyToClipboard(text)
}
