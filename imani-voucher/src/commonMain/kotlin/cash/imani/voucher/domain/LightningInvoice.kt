package cash.imani.voucher.domain

import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Represents a Lightning Network payment request for voucher purchase.
 *
 * In the marketplace model, customers purchase vouchers by paying Lightning invoices.
 * The mint generates the invoice quote (NUT-04), and customers pay it to receive
 * Cashu proofs that back the voucher.
 *
 * ## Lightning Payment Flow
 *
 * 1. **Customer Selects Offer**:
 *    ```kotlin
 *    val offer = merchantOffers.find { it.name == "Coffee Voucher" }
 *    ```
 *
 * 2. **Generate Invoice Quote (NUT-04)**:
 *    ```kotlin
 *    val invoice = createLightningInvoiceUseCase(
 *        amount = offer.price,
 *        mintUrl = "https://mint.example.com"
 *    ).getOrThrow()
 *    // Returns: LightningInvoice with quoteId and paymentRequest
 *    ```
 *
 * 3. **Customer Pays Invoice**:
 *    - Display invoice QR code or payment request string
 *    - Customer scans with Lightning wallet
 *    - Payment sent to mint via Lightning Network
 *
 * 4. **Poll for Payment Confirmation**:
 *    ```kotlin
 *    val isPaid = checkInvoicePaidUseCase(invoice.quoteId, mintUrl).getOrThrow()
 *    if (isPaid) {
 *        // Mint tokens from quote (NUT-04)
 *        val proofs = mintTokensFromQuote(invoice.quoteId, mintUrl)
 *        // Issue voucher locked to customer's pubkey
 *        issueVoucher(proofs, lockToPubkey = customerNpub)
 *    }
 *    ```
 *
 * ## NUT-04 Integration
 *
 * This model wraps the Cashu NUT-04 (Minting Tokens) flow:
 * - **POST /v1/mint/quote/bolt11**: Generates quote ID and Lightning invoice
 * - **GET /v1/mint/quote/bolt11/{quote_id}**: Checks payment status
 * - **POST /v1/mint/bolt11**: Mints tokens after payment confirmed
 *
 * ## Invoice States
 *
 * - **Unpaid** (`!paid && !isExpired()`): Waiting for payment
 * - **Paid** (`paid && !isExpired()`): Payment confirmed, ready to mint
 * - **Expired** (`isExpired()`): Invoice expired, payment no longer accepted
 *
 * @property quoteId Mint quote ID from NUT-04 (used for minting)
 * @property paymentRequest Lightning BOLT11 invoice string (lnbc...)
 * @property amount Amount in satoshis
 * @property paid Whether the invoice has been paid
 * @property expiresAt Expiration timestamp (typically 10-15 minutes)
 * @property createdAt Timestamp when invoice was created
 */
@Serializable
data class LightningInvoice(
    @SerialName("quoteId")
    val quoteId: String,
    @SerialName("paymentRequest")
    val paymentRequest: String,
    @SerialName("amount")
    val amount: Int,
    @SerialName("paid")
    val paid: Boolean = false,
    @SerialName("expiresAt")
    @Contextual
    val expiresAt: Instant,
    @SerialName("createdAt")
    @Contextual
    val createdAt: Instant,
) {
    init {
        require(quoteId.isNotBlank()) { "Quote ID cannot be blank" }
        require(paymentRequest.isNotBlank()) { "Payment request cannot be blank" }
        require(paymentRequest.startsWith("lnbc") || paymentRequest.startsWith("lntb")) {
            "Payment request must be a valid BOLT11 invoice (starts with lnbc/lntb), got: ${paymentRequest.take(10)}"
        }
        require(amount > 0) { "Amount must be positive, got $amount sats" }
    }

    /**
     * Checks if the invoice has expired.
     *
     * Expired invoices cannot be paid and should be regenerated.
     *
     * @return true if current time is past expiresAt
     */
    fun isExpired(): Boolean = Clock.System.now() > expiresAt

    /**
     * Checks if the invoice is valid (not paid and not expired).
     *
     * Valid invoices can still be paid by customers.
     *
     * @return true if invoice is unpaid and not expired
     */
    fun isValid(): Boolean = !paid && !isExpired()

    /**
     * Checks if the invoice is ready for minting tokens.
     *
     * After payment is confirmed, mint tokens using POST /v1/mint/bolt11 with quoteId.
     *
     * @return true if paid and not expired
     */
    fun canMint(): Boolean = paid && !isExpired()

    /**
     * Returns a copy of this invoice marked as paid.
     *
     * Use when payment confirmation is received from mint.
     *
     * @return New invoice with paid=true
     */
    fun markAsPaid(): LightningInvoice = copy(paid = true)
}
