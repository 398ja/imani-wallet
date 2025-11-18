import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.CanvasBasedWindow
import cash.imani.app.ImaniApp
import cash.imani.app.di.appModule
import org.koin.core.context.startKoin

/**
 * Entry point for Imani Wallet web application.
 *
 * Initializes Koin dependency injection and Compose for Web.
 */
@OptIn(ExperimentalComposeUiApi::class)
fun main() {
    // Initialize Koin for dependency injection
    startKoin {
        modules(appModule)
    }

    // Launch Compose-based UI
    CanvasBasedWindow(
        title = "Imani Wallet",
        canvasElementId = "ComposeTarget",
    ) {
        ImaniApp()
    }
}
