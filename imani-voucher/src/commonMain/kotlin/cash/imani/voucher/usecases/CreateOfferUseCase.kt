package cash.imani.voucher.usecases

import cash.imani.voucher.domain.MerchantOffer
import cash.imani.voucher.domain.OfferStatus
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.random.Random
import kotlin.time.Duration

/**
 * Creates a merchant offer for selling vouchers in the marketplace.
 *
 * Validates offer parameters and generates a unique offer ID. The created offer
 * is in DRAFT status and must be published to Nostr to become ACTIVE.
 *
 * **Use Case Flow**:
 * 1. Validate offer parameters (amount, price, description, etc.)
 * 2. Generate unique offer ID (UUID)
 * 3. Create MerchantOffer with DRAFT status
 * 4. Return offer (caller publishes to Nostr separately)
 *
 * **Validation Rules**:
 * - Amount must be positive
 * - Price must be positive and ≤ amount (no markup, only discounts allowed)
 * - Description must be non-blank (1-500 chars)
 * - Mint URL must be valid HTTP(S) URL
 * - Expiry duration must be positive (if specified)
 * - Unit must be non-blank
 *
 * **Example Usage**:
 * ```kotlin
 * val createOffer = CreateOfferUseCase()
 * val offer = createOffer(
 *     merchantId = "npub1...",
 *     amount = 1000L,
 *     price = 900L, // 10% discount
 *     description = "Buy 1000 sats voucher, get 10% off!",
 *     mintUrl = "https://mint.example.com",
 *     expiryDuration = 7.days
 * ).getOrThrow()
 *
 * // Publish to Nostr
 * publishOfferUseCase(offer).getOrThrow()
 * ```
 *
 * @see PublishOfferToNostrUseCase
 * @see MerchantOffer
 */
class CreateOfferUseCase {
    /**
     * Creates a new merchant offer.
     *
     * @param merchantId Merchant's Nostr public key (npub or hex)
     * @param amount Face value of voucher (in unit)
     * @param price Sale price (must be ≤ amount)
     * @param description Offer description (1-500 chars)
     * @param mintUrl Cashu mint URL (must be valid HTTP(S))
     * @param unit Unit of account (default: "sat")
     * @param expiryDuration Optional duration until offer expires
     * @param metadata Optional custom metadata tags
     * @return Result containing created MerchantOffer in DRAFT status
     */
    suspend operator fun invoke(
        merchantId: String,
        amount: Long,
        price: Long,
        description: String,
        mintUrl: String,
        unit: String = "sat",
        expiryDuration: Duration? = null,
        metadata: Map<String, String> = emptyMap(),
    ): Result<MerchantOffer> =
        runCatching {
            // Validate parameters
            validateOfferParameters(
                merchantId = merchantId,
                amount = amount,
                price = price,
                description = description,
                mintUrl = mintUrl,
                unit = unit,
                expiryDuration = expiryDuration,
            )

            // Generate unique offer ID
            val offerId = generateOfferId()

            // Calculate expiration timestamp
            val now = Clock.System.now()
            val expiresAt = expiryDuration?.let { now + it }

            // Create offer in DRAFT status
            MerchantOffer(
                offerId = offerId,
                merchantId = merchantId,
                amount = amount,
                unit = unit,
                price = price,
                description = description.trim(),
                mintUrl = mintUrl.trimEnd('/'),
                expiresAt = expiresAt,
                createdAt = now,
                status = OfferStatus.DRAFT,
                metadata = metadata,
            )
        }

    /**
     * Validates offer parameters.
     *
     * @throws IllegalArgumentException if validation fails
     */
    private fun validateOfferParameters(
        merchantId: String,
        amount: Long,
        price: Long,
        description: String,
        mintUrl: String,
        unit: String,
        expiryDuration: Duration?,
    ) {
        // Validate merchant ID
        require(merchantId.isNotBlank()) {
            "Merchant ID cannot be blank. " +
                "Suggestion: Provide a valid Nostr public key (npub or hex)."
        }

        // Validate amount
        require(amount > 0) {
            "Amount must be positive, got $amount. " +
                "Suggestion: Specify a positive face value for the voucher."
        }

        // Validate price
        require(price > 0) {
            "Price must be positive, got $price. " +
                "Suggestion: Specify a positive sale price."
        }

        require(price <= amount) {
            "Price ($price) cannot exceed amount ($amount). " +
                "Suggestion: Offers can only discount vouchers, not mark them up. " +
                "Set price ≤ amount for valid discount."
        }

        // Validate description
        val trimmedDesc = description.trim()
        require(trimmedDesc.isNotBlank()) {
            "Description cannot be blank. " +
                "Suggestion: Provide a clear description of the offer."
        }

        require(trimmedDesc.length in 1..500) {
            "Description must be 1-500 characters, got ${trimmedDesc.length}. " +
                "Suggestion: Keep description concise and informative."
        }

        // Validate mint URL
        require(mintUrl.isNotBlank()) {
            "Mint URL cannot be blank. " +
                "Suggestion: Provide a valid Cashu mint URL."
        }

        require(mintUrl.startsWith("http://") || mintUrl.startsWith("https://")) {
            "Mint URL must start with http:// or https://, got: $mintUrl. " +
                "Suggestion: Use a valid HTTP(S) URL for the Cashu mint."
        }

        // Validate unit
        require(unit.isNotBlank()) {
            "Unit cannot be blank. " +
                "Suggestion: Specify a unit of account (e.g., 'sat')."
        }

        // Validate expiry duration
        expiryDuration?.let {
            require(!it.isNegative()) {
                "Expiry duration cannot be negative, got: $it. " +
                    "Suggestion: Specify a positive duration or omit for no expiration."
            }
        }
    }

    /**
     * Generates a unique offer ID.
     *
     * Uses cryptographically secure random hex string for guaranteed uniqueness.
     * 16 bytes = 32 hex chars, sufficient for collision resistance.
     *
     * @return Unique offer ID string (32-character hex)
     */
    private fun generateOfferId(): String {
        val bytes = ByteArray(16)
        Random.Default.nextBytes(bytes)
        return bytes.joinToString("") { byte ->
            val hex = (byte.toInt() and 0xFF).toString(16)
            if (hex.length == 1) "0$hex" else hex
        }
    }
}
