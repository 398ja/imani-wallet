import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.CanvasBasedWindow
import cash.imani.app.ImaniApp

/**
 * Entry point for Imani Wallet web application.
 *
 * Initializes Compose for Web and launches the main app.
 */
@OptIn(ExperimentalComposeUiApi::class)
fun main() {
    CanvasBasedWindow(
        title = "Imani Wallet",
        canvasElementId = "ComposeTarget",
    ) {
        ImaniApp()
    }
}
