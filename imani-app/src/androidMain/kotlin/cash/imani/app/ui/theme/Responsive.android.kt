package cash.imani.app.ui.theme

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration

/**
 * Android implementation of window width provider.
 *
 * Uses LocalConfiguration to get screen width in dp.
 */
@Composable
actual fun rememberWindowWidth(): Int {
    val configuration = LocalConfiguration.current
    return configuration.screenWidthDp
}
