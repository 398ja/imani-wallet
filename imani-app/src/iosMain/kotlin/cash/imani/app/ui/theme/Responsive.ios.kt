package cash.imani.app.ui.theme

import androidx.compose.runtime.Composable

/**
 * iOS implementation of window width provider.
 *
 * TODO: Implement using UIScreen.main.bounds or similar.
 * For now, defaults to mobile size.
 */
@Composable
actual fun rememberWindowWidth(): Int {
    // Default to mobile size for iOS
    // In a real iOS app, would use UIScreen.main.bounds
    return 390 // iPhone 14 width
}
