package cash.imani.voucher.network

/**
 * Cashu Mint configuration for Imani Wallet.
 *
 * Provides default mint URLs and configuration options for voucher operations.
 */
object MintConfig {
    /**
     * Local test mint for development.
     *
     * Use this for testing without affecting production mints.
     * Start a local mint with nutshell on http://localhost:7777
     *
     * To run a local test mint:
     * ```
     * # Using cashu-feni (nutshell):
     * pip install cashu
     * cashu --port 7777
     * ```
     */
    const val LOCAL_MINT = "http://localhost:7777"

    /**
     * Production mint URLs.
     *
     * These are public mints. Do NOT use for testing!
     * Always test against LOCAL_MINT.
     */
    val PRODUCTION_MINTS =
        listOf(
            "https://mint.minibits.cash", // Minibits wallet mint
            "https://8333.space:3338", // Community mint
            "https://legend.lnbits.com", // LNbits mint
        )

    /**
     * Default mint based on environment configuration.
     *
     * - Development: Uses LOCAL_MINT (http://localhost:7777)
     * - Production: No default (user must select)
     *
     * Override by setting IMANI_MINT_ENV environment variable:
     * - "local" or "dev": Use LOCAL_MINT
     * - "production" or "prod": No default
     * - Specific URL: Use that URL directly
     */
    val DEFAULT_MINT: String
        get() {
            val env = getMintEnvironmentVariable("IMANI_MINT_ENV")
            return when {
                env == null -> LOCAL_MINT // Default to local for safety
                env.startsWith("http://") || env.startsWith("https://") -> env // Direct URL
                env.lowercase() in listOf("production", "prod") -> "" // No default for production
                else -> LOCAL_MINT // "local", "dev", or anything else
            }
        }

    /**
     * Test mint for unit tests (same as LOCAL_MINT).
     */
    const val TEST_MINT = LOCAL_MINT

    /**
     * Default unit of account.
     *
     * Currently only "sat" (satoshis) is widely supported.
     * Future: Support for USD, EUR, etc.
     */
    const val DEFAULT_UNIT = "sat"

    /**
     * Connection timeout for mint API calls (milliseconds).
     */
    const val CONNECTION_TIMEOUT_MS = 5000L

    /**
     * Read timeout for mint API calls (milliseconds).
     */
    const val READ_TIMEOUT_MS = 10000L

    /**
     * Maximum number of proofs to include in a single swap request.
     *
     * Some mints have limits on the number of proofs per request.
     */
    const val MAX_PROOFS_PER_SWAP = 100
}

/**
 * Gets mint environment variable.
 * Uses the same platform-specific implementation as NostrConfig.
 */
expect fun getMintEnvironmentVariable(name: String): String?
