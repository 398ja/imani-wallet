package cash.imani.app.ui.voucher

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent

/**
 * Android context holder for clipboard operations.
 * Set this from your Activity/Application.
 */
object AndroidContextHolder {
    var context: Context? = null
}

/**
 * Copies text to clipboard using Android ClipboardManager.
 */
actual fun copyToClipboard(text: String) {
    val context = AndroidContextHolder.context ?: run {
        println("[VoucherDetail] Context not available for clipboard")
        return
    }

    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("Imani Voucher", text)
    clipboard.setPrimaryClip(clip)
    println("[VoucherDetail] Copied to clipboard: ${text.take(20)}...")
}

/**
 * Shares text via Android share sheet.
 */
actual fun shareViaSystem(text: String) {
    val context = AndroidContextHolder.context ?: run {
        println("[VoucherDetail] Context not available for sharing")
        copyToClipboard(text)
        return
    }

    val sendIntent = Intent().apply {
        action = Intent.ACTION_SEND
        putExtra(Intent.EXTRA_TEXT, text)
        type = "text/plain"
    }

    val shareIntent = Intent.createChooser(sendIntent, "Share Voucher")
    shareIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(shareIntent)
}
