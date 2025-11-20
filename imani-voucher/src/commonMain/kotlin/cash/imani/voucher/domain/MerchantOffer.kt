package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Serializable

/**
 * Represents a merchant's offer to sell vouchers in the marketplace.
 *
 * Merchants create offers advertising vouchers they want to sell. Offers are
 * published to Nostr relays (NIP-33 kind 30078) where customers can discover them.
 *
 * **Marketplace Model Flow**:
 * 1. Merchant creates offer (face value, price, description)
 * 2. Offer published to Nostr relays
 * 3. Customers discover offers via query
 * 4. Customer pays Lightning invoice
 * 5. Mint issues voucher after payment confirmation
 * 6. Customer receives voucher tokens
 *
 * **NIP-33 Storage**: Offers use parameterized replaceable events (kind 30078)
 * with the offer ID as the "d" tag, allowing merchants to update/cancel offers.
 *
 * @property offerId Unique offer identifier (used as NIP-33 "d" tag)
 * @property merchantId Merchant's Nostr public key (npub/hex)
 * @property amount Face value of the voucher (in unit)
 * @property unit Unit of account (e.g., "sat" for satoshis)
 * @property price Price customer pays (in same unit). Can be discounted or equal to amount.
 * @property description Human-readable offer description
 * @property mintUrl Cashu mint URL where voucher will be issued
 * @property expiresAt Offer expiration timestamp (optional)
 * @property createdAt Offer creation timestamp
 * @property status Current offer status
 * @property metadata Optional metadata (tags, categories, etc.)
 */
@Serializable
data class MerchantOffer(
    val offerId: String,
    val merchantId: String,
    val amount: Long,
    val unit: String,
    val price: Long,
    val description: String,
    val mintUrl: String,
    val expiresAt: Instant? = null,
    val createdAt: Instant,
    val status: OfferStatus,
    val metadata: Map<String, String> = emptyMap(),
) {
    /**
     * Checks if offer is expired.
     *
     * @return true if expiresAt is set and in the past, false otherwise
     */
    fun isExpired(now: Instant): Boolean =
        expiresAt?.let { it < now } ?: false

    /**
     * Checks if offer is active and available for purchase.
     *
     * @return true if status is ACTIVE and not expired
     */
    fun isAvailable(now: Instant): Boolean =
        status == OfferStatus.ACTIVE && !isExpired(now)

    /**
     * Calculates discount percentage if price is less than amount.
     *
     * @return Discount percentage (0-100), or 0 if no discount
     */
    fun discountPercentage(): Int {
        if (price >= amount) return 0
        return ((amount - price) * 100 / amount).toInt()
    }

    /**
     * Converts to Nostr NIP-33 event tags.
     *
     * **Tag Format**:
     * - ["d", offerId] - Parameterized replaceable event identifier
     * - ["merchant", merchantId] - Merchant public key
     * - ["amount", amount, unit] - Face value
     * - ["price", price, unit] - Sale price
     * - ["mint", mintUrl] - Cashu mint URL
     * - ["expiry", expiresAt] - Optional expiration timestamp
     * - ["status", status] - Offer status
     *
     * @return List of tag arrays for Nostr event
     */
    fun toNostrTags(): List<List<String>> =
        buildList {
            add(listOf("d", offerId))
            add(listOf("merchant", merchantId))
            add(listOf("amount", amount.toString(), unit))
            add(listOf("price", price.toString(), unit))
            add(listOf("mint", mintUrl))
            expiresAt?.let { add(listOf("expiry", it.epochSeconds.toString())) }
            add(listOf("status", status.name))
            metadata.forEach { (key, value) ->
                add(listOf(key, value))
            }
        }

    companion object {
        /**
         * Parses MerchantOffer from Nostr NIP-33 event tags.
         *
         * @param tags List of tag arrays from Nostr event
         * @param content Event content (offer description)
         * @param createdAt Event creation timestamp
         * @return Parsed MerchantOffer
         * @throws IllegalArgumentException if required tags are missing
         */
        fun fromNostrTags(
            tags: List<List<String>>,
            content: String,
            createdAt: Instant,
        ): MerchantOffer {
            val tagMap = tags.associate { it[0] to it.drop(1) }

            val offerId =
                tagMap["d"]?.firstOrNull()
                    ?: throw IllegalArgumentException("Missing required tag: d (offerId)")
            val merchantId =
                tagMap["merchant"]?.firstOrNull()
                    ?: throw IllegalArgumentException("Missing required tag: merchant")
            val amountData =
                tagMap["amount"]
                    ?: throw IllegalArgumentException("Missing required tag: amount")
            val priceData =
                tagMap["price"]
                    ?: throw IllegalArgumentException("Missing required tag: price")
            val mintUrl =
                tagMap["mint"]?.firstOrNull()
                    ?: throw IllegalArgumentException("Missing required tag: mint")

            val amount = amountData[0].toLong()
            val unit = amountData.getOrNull(1) ?: "sat"
            val price = priceData[0].toLong()
            val statusStr = tagMap["status"]?.firstOrNull() ?: "ACTIVE"
            val expiryStr = tagMap["expiry"]?.firstOrNull()

            // Extract metadata (non-standard tags)
            val standardTags = setOf("d", "merchant", "amount", "price", "mint", "expiry", "status")
            val metadata =
                tags.filter { it[0] !in standardTags && it.size >= 2 }
                    .associate { it[0] to it[1] }

            return MerchantOffer(
                offerId = offerId,
                merchantId = merchantId,
                amount = amount,
                unit = unit,
                price = price,
                description = content,
                mintUrl = mintUrl,
                expiresAt = expiryStr?.let { Instant.fromEpochSeconds(it.toLong()) },
                createdAt = createdAt,
                status = OfferStatus.valueOf(statusStr),
                metadata = metadata,
            )
        }
    }
}

/**
 * Offer status lifecycle.
 *
 * **State Transitions**:
 * - DRAFT → ACTIVE (publish to Nostr)
 * - ACTIVE → PAUSED (temporarily unavailable)
 * - ACTIVE → SOLD_OUT (all vouchers sold)
 * - ACTIVE → CANCELLED (merchant cancels)
 * - ACTIVE → EXPIRED (expiresAt reached)
 * - PAUSED → ACTIVE (resume offer)
 * - PAUSED → CANCELLED (cancel while paused)
 */
@Serializable
enum class OfferStatus {
    /** Draft offer, not yet published */
    DRAFT,

    /** Active and available for purchase */
    ACTIVE,

    /** Temporarily paused by merchant */
    PAUSED,

    /** All available vouchers sold out */
    SOLD_OUT,

    /** Cancelled by merchant */
    CANCELLED,

    /** Expired (expiresAt reached) */
    EXPIRED,
}
