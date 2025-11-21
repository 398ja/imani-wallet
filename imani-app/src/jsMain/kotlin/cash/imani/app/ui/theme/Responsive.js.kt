package cash.imani.app.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.browser.window

/**
 * JS implementation of window width provider.
 *
 * Uses window.innerWidth and listens for resize events.
 */
@Composable
actual fun rememberWindowWidth(): Int {
    var width by remember { mutableStateOf(window.innerWidth) }

    DisposableEffect(Unit) {
        val listener: (dynamic) -> Unit = {
            width = window.innerWidth
        }
        window.addEventListener("resize", listener)
        onDispose {
            window.removeEventListener("resize", listener)
        }
    }

    return width
}
