package cash.imani.voucher.usecases

import cash.imani.voucher.domain.LightningInvoice
import cash.imani.voucher.network.MintApiClient
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.time.Duration.Companion.minutes

/**
 * Use case for creating a Lightning invoice for voucher purchase.
 *
 * In the marketplace model, customers purchase vouchers by paying Lightning invoices.
 * This use case generates a quote from the mint (NUT-04) and returns a LightningInvoice
 * that can be displayed to the customer for payment.
 *
 * ## Flow
 *
 * 1. **Customer selects merchant offer**:
 *    ```kotlin
 *    val offer = merchantOffers.find { it.name == "Coffee Voucher" }
 *    ```
 *
 * 2. **Generate Lightning invoice**:
 *    ```kotlin
 *    val invoice = createLightningInvoiceUseCase(
 *        amount = offer.price,
 *        mintUrl = "https://mint.example.com"
 *    ).getOrThrow()
 *    ```
 *
 * 3. **Display to customer**:
 *    ```kotlin
 *    // Show QR code of invoice.paymentRequest
 *    // Or provide copy/paste of BOLT11 string
 *    ```
 *
 * 4. **Customer pays with Lightning wallet**:
 *    - Scans QR code or pastes invoice
 *    - Lightning payment sent to mint
 *
 * 5. **Poll for payment confirmation**:
 *    ```kotlin
 *    val isPaid = checkInvoicePaidUseCase(invoice.quoteId, mintUrl).getOrThrow()
 *    if (isPaid) {
 *        // Mint tokens and issue voucher
 *    }
 *    ```
 *
 * ## Error Handling
 *
 * - **Network errors**: Returns Result.failure with IOException
 * - **Invalid amount**: Returns Result.failure with IllegalArgumentException
 * - **Mint unavailable**: Returns Result.failure with HttpException
 *
 * @property mintApiClient Client for Cashu Mint API
 *
 * @see CheckInvoicePaidUseCase For polling payment status
 * @see LightningInvoice Domain model for invoice
 */
class CreateLightningInvoiceUseCase(
    private val mintApiClient: MintApiClient,
) {
    /**
     * Creates a Lightning invoice for purchasing a voucher.
     *
     * Calls POST /v1/mint/quote/bolt11 on the mint to generate a quote.
     * The returned invoice can be paid by the customer to receive Cashu proofs.
     *
     * @param amount Amount in satoshis to mint
     * @param mintUrl URL of the Cashu mint (e.g., "https://mint.example.com")
     * @param unit Unit of account (default: "sat")
     * @return Result containing LightningInvoice or error
     *
     * @throws IllegalArgumentException if amount is non-positive
     * @throws IOException if network request fails
     * @throws HttpException if mint returns error response
     */
    suspend operator fun invoke(
        amount: Int,
        mintUrl: String,
        unit: String = "sat",
    ): Result<LightningInvoice> =
        runCatching {
            require(amount > 0) { "Amount must be positive, got $amount sats" }
            require(mintUrl.isNotBlank()) { "Mint URL cannot be blank" }

            // Request quote from mint
            val quoteResponse =
                mintApiClient.getMintQuote(mintUrl, amount, unit)
                    .getOrThrow()

            // Convert to domain model
            LightningInvoice(
                quoteId = quoteResponse.quote,
                paymentRequest = quoteResponse.request,
                amount = amount,
                paid = quoteResponse.paid,
                expiresAt = Instant.fromEpochSeconds(quoteResponse.expiry),
                createdAt = Clock.System.now(),
            )
        }
}
