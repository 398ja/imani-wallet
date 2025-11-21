package cash.imani.monitoring

/**
 * Error tracking configuration for Sentry integration.
 *
 * Initializes Sentry for JavaScript runtime to capture and report errors
 * in production deployments.
 */
object ErrorTracking {
    /**
     * Initialize error tracking with Sentry.
     * Only activates in production builds with valid DSN.
     */
    fun initialize() {
        val sentryDsn = getSentryDsn()

        if (sentryDsn.isNullOrBlank()) {
            console.log("[ErrorTracking] Sentry DSN not configured - error tracking disabled")
            return
        }

        try {
            // Check if Sentry is loaded
            val sentryLoaded = js("typeof Sentry !== 'undefined'") as Boolean
            if (!sentryLoaded) {
                console.warn("[ErrorTracking] Sentry SDK not loaded - error tracking disabled")
                return
            }

            // Initialize Sentry with configuration
            js("Sentry").asDynamic().init(
                js(
                    """{
                dsn: sentryDsn,
                environment: 'production',
                release: 'imani-wallet@unknown',
                tracesSampleRate: 0.1,
                ignoreErrors: [
                    'top.GLOBALS',
                    'canvas.contentDocument',
                    'NetworkError',
                    'Failed to fetch'
                ]
            }""",
                ),
            )

            console.log("[ErrorTracking] Sentry initialized successfully")
        } catch (e: Throwable) {
            console.error("[ErrorTracking] Failed to initialize Sentry:", e.message)
        }
    }

    /**
     * Capture an exception manually.
     */
    @Suppress("UNUSED_PARAMETER")
    fun captureException(
        error: Throwable,
        context: Map<String, Any>? = null,
    ) {
        if (js("typeof Sentry === 'undefined'") as Boolean) {
            return
        }

        try {
            if (context != null) {
                js("Sentry.setContext('additional', context)")
            }
            js("Sentry.captureException(error)")
        } catch (e: Throwable) {
            console.error("[ErrorTracking] Failed to capture exception:", e.message)
        }
    }

    /**
     * Set user context for error reports.
     */
    @Suppress("UNUSED_PARAMETER")
    fun setUser(userId: String) {
        if (js("typeof Sentry === 'undefined'") as Boolean) {
            return
        }

        try {
            js("Sentry.setUser({ id: userId })")
        } catch (e: Throwable) {
            console.error("[ErrorTracking] Failed to set user context:", e.message)
        }
    }

    private fun getSentryDsn(): String? {
        return try {
            js("process.env.SENTRY_DSN || null") as? String
        } catch (e: Throwable) {
            null
        }
    }
}
