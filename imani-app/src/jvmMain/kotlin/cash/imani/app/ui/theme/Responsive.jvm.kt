package cash.imani.app.ui.theme

import androidx.compose.runtime.Composable

/**
 * JVM implementation of window width provider.
 *
 * For JVM desktop, defaults to desktop size.
 * TODO: Implement actual window size detection for Compose Desktop.
 */
@Composable
actual fun rememberWindowWidth(): Int {
    // Default to desktop size for JVM
    // In a real Compose Desktop app, would use LocalWindow or similar
    return 1200
}
