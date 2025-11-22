package cash.imani.voucher.usecases

import cash.imani.voucher.domain.MerchantProfile
import cash.imani.voucher.repository.MerchantProfileRepository
import kotlinx.datetime.Clock

/**
 * Use case for updating a merchant's business profile.
 *
 * Validates profile data and persists changes to Nostr (NIP-33 kind 30078).
 * Each merchant has exactly one profile, identified by their Nostr npub.
 *
 * **Business Rules**:
 * - Business name must be 1-100 characters
 * - Description must be 1-500 characters
 * - Contact fields are optional
 * - Updates replace previous profile (NIP-33 parameterized replaceable event)
 *
 * **Use Cases**:
 * - Merchant updates business name or description
 * - Merchant adds/updates contact information
 * - Merchant updates logo URL
 *
 * **Example Usage**:
 * ```kotlin
 * val updateProfile = UpdateMerchantProfileUseCase(merchantProfileRepository)
 *
 * val result = updateProfile(
 *     merchantId = "npub1...",
 *     businessName = "Cafe Imani",
 *     description = "Specialty coffee and pastries in downtown",
 *     logoUrl = "https://example.com/logo.png",
 *     contactEmail = "hello@cafe-imani.com",
 *     contactPhone = "+1-555-0123",
 *     website = "https://cafe-imani.com"
 * )
 *
 * result.onSuccess { updatedProfile ->
 *     println("Profile updated: ${updatedProfile.businessName}")
 * }.onFailure { error ->
 *     println("Update failed: ${error.message}")
 * }
 * ```
 *
 * **Nostr Storage**:
 * Profile is published as NIP-33 event:
 * - Kind: 30078
 * - d tag: "profile"
 * - Content: JSON-encoded MerchantProfile
 * - Tags: business_name, website for discoverability
 *
 * @property merchantProfileRepository Repository for merchant profile persistence
 *
 * @see MerchantProfile Domain model for merchant business information
 * @see MerchantProfileRepository Repository interface for profile storage
 */
class UpdateMerchantProfileUseCase(
    private val merchantProfileRepository: MerchantProfileRepository,
) {
    /**
     * Updates merchant profile with validated data.
     *
     * **Validation**:
     * 1. Business name: 1-100 characters, non-blank
     * 2. Description: 1-500 characters, non-blank
     * 3. Merchant ID: Must be valid Nostr npub
     *
     * **Process**:
     * 1. Retrieve existing profile (if any)
     * 2. Create updated profile with new data
     * 3. Set updatedAt to current timestamp
     * 4. Validate all fields
     * 5. Persist to Nostr (NIP-33 replaceable event)
     * 6. Return updated profile
     *
     * **Edge Cases**:
     * - First-time profile creation: Sets createdAt = updatedAt
     * - Existing profile update: Preserves createdAt, updates updatedAt
     * - Invalid data: Returns failure with validation error
     *
     * @param merchantId Merchant's Nostr public key (npub format)
     * @param businessName Updated business name
     * @param description Updated description
     * @param logoUrl Optional logo URL (null to remove)
     * @param contactEmail Optional contact email (null to remove)
     * @param contactPhone Optional contact phone (null to remove)
     * @param website Optional website URL (null to remove)
     * @return Result containing updated MerchantProfile or error
     */
    suspend operator fun invoke(
        merchantId: String,
        businessName: String,
        description: String,
        logoUrl: String? = null,
        contactEmail: String? = null,
        contactPhone: String? = null,
        website: String? = null,
    ): Result<MerchantProfile> =
        runCatching {
            // 1. Retrieve existing profile (if any)
            val existingProfile = merchantProfileRepository.getProfile(merchantId).getOrNull()

            // 2. Create updated profile
            val now = Clock.System.now()
            val updatedProfile =
                MerchantProfile(
                    merchantId = merchantId,
                    businessName = businessName.trim(),
                    description = description.trim(),
                    logoUrl = logoUrl?.trim()?.takeIf { it.isNotBlank() },
                    contactEmail = contactEmail?.trim()?.takeIf { it.isNotBlank() },
                    contactPhone = contactPhone?.trim()?.takeIf { it.isNotBlank() },
                    website = website?.trim()?.takeIf { it.isNotBlank() },
                    // Preserve createdAt if updating, otherwise use now
                    createdAt = existingProfile?.createdAt ?: now,
                    updatedAt = now,
                )

            // 3. Validate via domain model (init block will throw if invalid)
            // 4. Persist to Nostr
            merchantProfileRepository.saveProfile(updatedProfile).getOrElse {
                throw MerchantProfileUpdateException(
                    "Failed to save profile to Nostr: ${it.message}",
                    it,
                )
            }

            // 5. Return updated profile
            updatedProfile
        }
}

/**
 * Exception thrown when merchant profile update fails.
 *
 * @param message Error description
 * @param cause Underlying cause (optional)
 */
class MerchantProfileUpdateException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
