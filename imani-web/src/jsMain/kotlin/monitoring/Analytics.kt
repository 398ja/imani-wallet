package cash.imani.monitoring

/**
 * Privacy-respecting analytics configuration using Plausible.
 *
 * Plausible is a lightweight, open-source analytics solution that:
 * - Doesn't use cookies
 * - Doesn't track personal data
 * - Is GDPR/CCPA compliant by default
 * - Has minimal performance impact
 */
object Analytics {

    private var initialized = false

    /**
     * Initialize analytics tracking.
     * Only activates in production with valid domain configuration.
     */
    fun initialize() {
        val domain = getPlausibleDomain()

        if (domain.isNullOrBlank()) {
            console.log("[Analytics] Plausible domain not configured - analytics disabled")
            return
        }

        if (initialized) {
            console.warn("[Analytics] Already initialized")
            return
        }

        try {
            // Inject Plausible script
            js("""
                (function() {
                    var script = document.createElement('script');
                    script.defer = true;
                    script.setAttribute('data-domain', domain);
                    script.src = 'https://plausible.io/js/script.js';
                    document.head.appendChild(script);
                })()
            """)

            initialized = true
            console.log("[Analytics] Plausible initialized for domain:", domain)
        } catch (e: Throwable) {
            console.error("[Analytics] Failed to initialize Plausible:", e.message)
        }
    }

    /**
     * Track a custom event.
     *
     * @param eventName Name of the event (e.g., "Voucher Created", "Settings Opened")
     * @param props Optional properties to attach to the event
     */
    fun trackEvent(eventName: String, props: Map<String, Any>? = null) {
        if (!initialized) {
            return
        }

        try {
            if (js("typeof plausible === 'undefined'") as Boolean) {
                console.warn("[Analytics] Plausible not loaded yet")
                return
            }

            if (props != null) {
                js("plausible(eventName, { props: props })")
            } else {
                js("plausible(eventName)")
            }
        } catch (e: Throwable) {
            console.error("[Analytics] Failed to track event:", e.message)
        }
    }

    /**
     * Track page view (usually automatic with Plausible).
     * Only needed for SPA manual navigation tracking.
     */
    fun trackPageView(path: String) {
        if (!initialized) {
            return
        }

        try {
            if (js("typeof plausible === 'undefined'") as Boolean) {
                return
            }

            js("plausible('pageview', { u: path })")
        } catch (e: Throwable) {
            console.error("[Analytics] Failed to track pageview:", e.message)
        }
    }

    private fun getPlausibleDomain(): String? {
        return try {
            js("process.env.PLAUSIBLE_DOMAIN || window.location.hostname") as? String
        } catch (e: Throwable) {
            null
        }
    }
}
