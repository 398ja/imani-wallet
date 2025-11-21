package cash.imani.app.ui.utils

import java.awt.Toolkit
import java.awt.datatransfer.StringSelection

/**
 * Copies text to the system clipboard using AWT Toolkit.
 *
 * Note: This is a basic implementation for desktop/JVM. For Android,
 * this will need to be overridden with android.content.ClipboardManager.
 */
actual suspend fun copyToClipboard(text: String): Boolean {
    return try {
        val clipboard = Toolkit.getDefaultToolkit().systemClipboard
        clipboard.setContents(StringSelection(text), null)
        true
    } catch (e: Exception) {
        e.printStackTrace()
        false
    }
}
