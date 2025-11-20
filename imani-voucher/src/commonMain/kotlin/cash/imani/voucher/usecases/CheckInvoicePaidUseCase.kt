package cash.imani.voucher.usecases

import cash.imani.voucher.network.MintApiClient
import kotlinx.coroutines.delay
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Use case for checking if a Lightning invoice has been paid.
 *
 * Polls the mint (NUT-04) to check if the customer has paid the invoice.
 * Once paid, the app can proceed to mint tokens and issue the voucher.
 *
 * ## Polling Strategy
 *
 * - **Interval**: 2 seconds between checks (configurable)
 * - **Timeout**: Maximum duration to poll before giving up
 * - **Early exit**: Stops immediately when payment detected
 *
 * ## Usage
 *
 * ```kotlin
 * // Generate invoice
 * val invoice = createLightningInvoiceUseCase(1000, mintUrl).getOrThrow()
 *
 * // Display to customer
 * showQRCode(invoice.paymentRequest)
 *
 * // Poll for payment (with 5-minute timeout)
 * val isPaid = checkInvoicePaidUseCase(
 *     quoteId = invoice.quoteId,
 *     mintUrl = mintUrl,
 *     timeout = 5.minutes
 * ).getOrThrow()
 *
 * if (isPaid) {
 *     // Mint tokens from quote
 *     val proofs = mintTokensFromQuote(invoice.quoteId, mintUrl)
 *     // Issue voucher locked to customer
 *     issueVoucher(proofs, lockToPubkey = customerNpub)
 * }
 * ```
 *
 * ## Error Handling
 *
 * - **Timeout**: Returns false if payment not confirmed within timeout
 * - **Network errors**: Returns Result.failure with IOException
 * - **Invalid quote**: Returns Result.failure with HttpException
 *
 * @property mintApiClient Client for Cashu Mint API
 *
 * @see CreateLightningInvoiceUseCase For generating invoices
 */
class CheckInvoicePaidUseCase(
    private val mintApiClient: MintApiClient,
) {
    /**
     * Checks if a Lightning invoice has been paid, with optional polling.
     *
     * If timeout is zero, performs a single check and returns immediately.
     * If timeout is positive, polls until paid or timeout reached.
     *
     * @param quoteId Quote ID from CreateLightningInvoiceUseCase
     * @param mintUrl URL of the Cashu mint
     * @param pollInterval Duration between polling attempts (default: 2 seconds)
     * @param timeout Maximum duration to poll (default: 0 = single check)
     * @return Result containing true if paid, false if unpaid/timeout
     *
     * @throws IOException if network request fails
     * @throws HttpException if mint returns error response
     */
    suspend operator fun invoke(
        quoteId: String,
        mintUrl: String,
        pollInterval: Duration = 2.seconds,
        timeout: Duration = Duration.ZERO,
    ): Result<Boolean> =
        runCatching {
            require(quoteId.isNotBlank()) { "Quote ID cannot be blank" }
            require(mintUrl.isNotBlank()) { "Mint URL cannot be blank" }

            // Single check mode (no polling)
            if (timeout == Duration.ZERO) {
                val quoteResponse = mintApiClient.checkMintQuote(mintUrl, quoteId).getOrThrow()
                return@runCatching quoteResponse.paid
            }

            // Polling mode
            val startTime = kotlinx.datetime.Clock.System.now()
            val endTime = startTime + timeout

            while (kotlinx.datetime.Clock.System.now() < endTime) {
                val quoteResponse = mintApiClient.checkMintQuote(mintUrl, quoteId).getOrThrow()

                if (quoteResponse.paid) {
                    return@runCatching true
                }

                // Wait before next poll
                delay(pollInterval)
            }

            // Timeout reached, payment not confirmed
            false
        }

    /**
     * Polls continuously until payment is confirmed or timeout.
     *
     * Convenience method that always uses polling mode.
     *
     * @param quoteId Quote ID from CreateLightningInvoiceUseCase
     * @param mintUrl URL of the Cashu mint
     * @param pollInterval Duration between polling attempts (default: 2 seconds)
     * @param timeout Maximum duration to poll (default: 5 minutes)
     * @return Result containing true if paid, false if timeout
     */
    suspend fun pollUntilPaid(
        quoteId: String,
        mintUrl: String,
        pollInterval: Duration = 2.seconds,
        timeout: Duration = 300.seconds, // 5 minutes
    ): Result<Boolean> = invoke(quoteId, mintUrl, pollInterval, timeout)
}
