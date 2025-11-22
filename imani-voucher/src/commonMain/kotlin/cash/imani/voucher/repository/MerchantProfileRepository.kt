package cash.imani.voucher.repository

import cash.imani.voucher.domain.MerchantProfile

/**
 * Repository interface for merchant profile persistence.
 *
 * Manages storage and retrieval of merchant business profiles on Nostr.
 * Profiles are stored as NIP-33 parameterized replaceable events.
 *
 * **Storage Strategy**:
 * - Primary storage: Nostr relays (NIP-33 kind 30078, d tag "profile")
 * - Local cache: Platform-specific (IndexedDB for web, SQLDelight for mobile)
 * - Updates: Replace previous profile (NIP-33 ensures single profile per merchant)
 *
 * **Implementations**:
 * - Web: NostrMerchantProfileRepository (Nostr + IndexedDB cache)
 * - JVM: JvmMerchantProfileRepository (Nostr + in-memory cache)
 * - Android/iOS: Platform-specific with SQLDelight
 *
 * @see MerchantProfile Domain model for merchant business information
 * @see UpdateMerchantProfileUseCase Use case for updating profiles
 */
interface MerchantProfileRepository {
    /**
     * Retrieves merchant profile by Nostr npub.
     *
     * Queries Nostr relays for merchant's profile event (kind 30078, d tag "profile").
     * Falls back to local cache if Nostr query fails.
     *
     * **Query Process**:
     * 1. Check local cache first (fast)
     * 2. Query Nostr relays in background
     * 3. Update cache if Nostr has newer profile
     * 4. Return cached or Nostr result
     *
     * @param merchantId Merchant's Nostr public key (npub format)
     * @return Result containing MerchantProfile or error if not found
     */
    suspend fun getProfile(merchantId: String): Result<MerchantProfile>

    /**
     * Saves or updates merchant profile.
     *
     * Publishes profile to Nostr as NIP-33 event and updates local cache.
     * If profile already exists, replaces it (NIP-33 guarantees single profile).
     *
     * **Save Process**:
     * 1. Validate profile data (domain model validation)
     * 2. Create NIP-33 event (kind 30078, d tag "profile")
     * 3. Sign event with merchant's private key
     * 4. Publish to Nostr relays
     * 5. Update local cache on success
     *
     * **NIP-33 Event Format**:
     * ```json
     * {
     *   "kind": 30078,
     *   "content": "{JSON-encoded MerchantProfile}",
     *   "tags": [
     *     ["d", "profile"],
     *     ["business_name", "Cafe Imani"],
     *     ["website", "https://cafe-imani.com"]
     *   ]
     * }
     * ```
     *
     * @param profile Merchant profile to save
     * @return Result indicating success or failure
     */
    suspend fun saveProfile(profile: MerchantProfile): Result<Unit>

    /**
     * Deletes merchant profile.
     *
     * Publishes deletion event to Nostr (NIP-09) and clears local cache.
     *
     * **Note**: Deletion on Nostr is cooperative - relays may choose to keep data.
     * This method marks the profile as deleted but doesn't guarantee erasure.
     *
     * @param merchantId Merchant's Nostr public key (npub format)
     * @return Result indicating success or failure
     */
    suspend fun deleteProfile(merchantId: String): Result<Unit>
}
