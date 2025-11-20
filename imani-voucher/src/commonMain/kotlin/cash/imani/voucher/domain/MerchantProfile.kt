package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Represents a merchant's business profile and metadata.
 *
 * Merchants publish profiles on Nostr (NIP-33 kind 30078) to provide business
 * information to customers. Profiles are discovered when customers scan the
 * merchant's Nostr npub QR code or search for merchants.
 *
 * ## Profile Discovery Flow
 *
 * 1. **Merchant Publishes Profile**:
 *    ```kotlin
 *    val profile = MerchantProfile(
 *        merchantId = merchantNpub,
 *        businessName = "Cafe Imani",
 *        description = "Specialty coffee and pastries in downtown",
 *        logoUrl = "https://example.com/logo.png",
 *        contactEmail = "hello@cafe-imani.com",
 *        website = "https://cafe-imani.com"
 *    )
 *    publishProfileToNostr(profile)
 *    ```
 *
 * 2. **Customer Discovers Merchant**:
 *    - Scans merchant's Nostr npub QR code at POS
 *    - App queries Nostr for merchant's profile (kind 30078, d tag "profile")
 *    - Displays business name, description, logo, contact info
 *    - Shows available voucher offers
 *
 * 3. **Profile Updates**:
 *    - Merchant updates profile (e.g., new logo, phone number)
 *    - Publishes updated NIP-33 event (replaces previous profile)
 *    - Customers see updated profile on next query
 *
 * ## Nostr Storage
 *
 * Profiles are stored as NIP-33 parameterized replaceable events:
 * - **Kind**: 30078
 * - **d tag**: "profile" (fixed identifier for merchant profile)
 * - **Content**: JSON-encoded MerchantProfile
 * - **Tags**: ["business_name", "Cafe Imani"], ["website", "https://cafe-imani.com"]
 *
 * Only one profile per merchant (NIP-33 ensures replacement of old profiles).
 *
 * ## Validation Rules
 *
 * - Business name: 1-100 characters, non-blank
 * - Description: 1-500 characters, non-blank
 * - Logo URL: Optional, must be valid URL if provided
 * - Contact fields: Optional
 * - Merchant ID: Must be valid Nostr npub
 *
 * @property merchantId Merchant's Nostr public key (npub format)
 * @property businessName Legal or common business name
 * @property description Business description (products, services, location)
 * @property logoUrl Optional URL to business logo image
 * @property contactEmail Optional business email address
 * @property contactPhone Optional business phone number
 * @property website Optional business website URL
 * @property createdAt Timestamp when profile was first created
 * @property updatedAt Timestamp of last profile update
 */
@Serializable
data class MerchantProfile(
    @SerialName("merchantId")
    val merchantId: String,
    @SerialName("businessName")
    val businessName: String,
    @SerialName("description")
    val description: String,
    @SerialName("logoUrl")
    val logoUrl: String? = null,
    @SerialName("contactEmail")
    val contactEmail: String? = null,
    @SerialName("contactPhone")
    val contactPhone: String? = null,
    @SerialName("website")
    val website: String? = null,
    @SerialName("createdAt")
    @Contextual
    val createdAt: Instant,
    @SerialName("updatedAt")
    @Contextual
    val updatedAt: Instant,
) {
    init {
        require(merchantId.isNotBlank()) { "Merchant ID cannot be blank" }
        require(businessName.isNotBlank()) { "Business name cannot be blank" }
        require(businessName.length in 1..100) {
            "Business name must be 1-100 characters, got ${businessName.length}"
        }
        require(description.isNotBlank()) { "Description cannot be blank" }
        require(description.length in 1..500) {
            "Description must be 1-500 characters, got ${description.length}"
        }
    }

    /**
     * Checks if this profile has complete contact information.
     *
     * @return true if at least one contact method is provided
     */
    fun hasContactInfo(): Boolean =
        contactEmail != null || contactPhone != null || website != null

    /**
     * Returns a copy of this profile with updated timestamp.
     *
     * Use when updating profile fields to ensure updatedAt is current.
     *
     * @return New profile with current updatedAt timestamp
     */
    fun withUpdatedTimestamp(): MerchantProfile =
        copy(updatedAt = kotlinx.datetime.Clock.System.now())
}
