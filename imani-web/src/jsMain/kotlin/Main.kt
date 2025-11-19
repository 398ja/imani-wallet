import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.window.CanvasBasedWindow
import cash.imani.app.ImaniApp
import cash.imani.app.di.appModule
import cash.imani.monitoring.Analytics
import cash.imani.monitoring.ErrorTracking
import org.koin.core.context.startKoin

/**
 * Entry point for Imani Wallet web application.
 *
 * Initializes Koin dependency injection, monitoring, and Compose for Web.
 */
@OptIn(ExperimentalComposeUiApi::class)
fun main() {
    console.log("[Imani] Starting application...")

    try {
        // Initialize error tracking and analytics
        console.log("[Imani] Initializing monitoring...")
        ErrorTracking.initialize()
        Analytics.initialize()

        // Initialize Koin for dependency injection
        console.log("[Imani] Initializing Koin...")
        startKoin {
            modules(appModule)
        }
        console.log("[Imani] Koin initialized successfully")

        // Launch Compose-based UI
        console.log("[Imani] Launching Compose UI...")
        CanvasBasedWindow(
            title = "Imani Wallet",
            canvasElementId = "ComposeTarget",
        ) {
            console.log("[Imani] Rendering ImaniApp...")
            ImaniApp()
        }
        console.log("[Imani] Application started successfully")
    } catch (e: Throwable) {
        console.error("[Imani] Fatal error during initialization:", e)
        console.error("[Imani] Error message:", e.message)
        console.error("[Imani] Error stack:", e.stackTraceToString())

        // Report error to Sentry if configured
        ErrorTracking.captureException(e, mapOf(
            "phase" to "initialization",
            "location" to "main"
        ))
    }
}
