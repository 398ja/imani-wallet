package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Represents a merchant's voucher offering (template for voucher issuance).
 *
 * Merchants create offers to define standardized vouchers they sell. Each offer
 * specifies the price, validity period, and redemption rules. Customers discover
 * offers via Nostr (NIP-33 kind 30078 events) and purchase them using Lightning.
 *
 * ## Marketplace Flow
 *
 * 1. **Merchant Creates Offer**:
 *    ```kotlin
 *    val offer = VoucherOffer(
 *        offerId = UUID.randomUUID().toString(),
 *        merchantId = merchantNpub,
 *        name = "Coffee Voucher",
 *        description = "Get any regular coffee at our shop",
 *        price = 5000, // 5000 sats
 *        validityDays = 30,
 *        allowPartialRedemption = true
 *    )
 *    publishOfferToNostr(offer) // Publishes NIP-33 event
 *    ```
 *
 * 2. **Customer Discovers Offer**:
 *    - Scans merchant's Nostr npub QR code
 *    - Queries Nostr relays for merchant's offers (kind 30078)
 *    - Browses available vouchers
 *
 * 3. **Customer Purchases Voucher**:
 *    - Generates Lightning invoice for offer price
 *    - Pays invoice
 *    - Receives voucher locked to their public key (P2PK)
 *
 * 4. **Customer Redeems Voucher**:
 *    - Presents voucher at merchant POS
 *    - Merchant verifies signature and expiration
 *    - Voucher proofs imported to merchant wallet
 *
 * ## Nostr Storage
 *
 * Offers are stored as NIP-33 parameterized replaceable events:
 * - **Kind**: 30078
 * - **d tag**: offerId (unique identifier)
 * - **Content**: JSON-encoded VoucherOffer
 * - **Tags**: ["price", "5000"], ["name", "Coffee Voucher"], ["active", "true"]
 *
 * @property offerId Unique identifier for this offer (UUID)
 * @property merchantId Merchant's Nostr public key (npub format)
 * @property name Short display name (e.g., "Coffee Voucher")
 * @property description Detailed description (e.g., "Get any regular coffee")
 * @property price Price in satoshis (minimum 1 sat)
 * @property validityDays Voucher validity period in days from issuance
 * @property allowPartialRedemption Whether partial redemption is allowed
 * @property createdAt Timestamp when offer was created
 * @property active Whether this offer is currently available for purchase
 */
@Serializable
data class VoucherOffer(
    @SerialName("offerId")
    val offerId: String,
    @SerialName("merchantId")
    val merchantId: String,
    @SerialName("name")
    val name: String,
    @SerialName("description")
    val description: String,
    @SerialName("price")
    val price: Int,
    @SerialName("validityDays")
    val validityDays: Int,
    @SerialName("allowPartialRedemption")
    val allowPartialRedemption: Boolean = true,
    @SerialName("createdAt")
    @Contextual
    val createdAt: Instant,
    @SerialName("active")
    val active: Boolean = true,
) {
    init {
        require(offerId.isNotBlank()) { "Offer ID cannot be blank" }
        require(merchantId.isNotBlank()) { "Merchant ID cannot be blank" }
        require(name.isNotBlank()) { "Offer name cannot be blank" }
        require(description.isNotBlank()) { "Offer description cannot be blank" }
        require(price > 0) { "Price must be positive, got $price sats" }
        require(validityDays > 0) { "Validity days must be positive, got $validityDays days" }
    }

    /**
     * Checks if this offer is available for purchase.
     *
     * @return true if active and price is valid
     */
    fun isAvailable(): Boolean = active && price > 0

    /**
     * Calculates the expiration timestamp for a voucher issued from this offer.
     *
     * @return Expiration timestamp (epoch seconds)
     */
    fun calculateExpiration(): Long {
        val now = kotlinx.datetime.Clock.System.now()
        return now.plus(kotlin.time.Duration.parse("${validityDays}d")).epochSeconds
    }
}
