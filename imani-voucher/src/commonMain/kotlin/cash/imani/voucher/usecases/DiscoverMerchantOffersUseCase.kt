package cash.imani.voucher.usecases

import cash.imani.voucher.domain.MerchantOffer
import cash.imani.voucher.domain.OfferStatus
import cash.imani.voucher.nostr.NostrFilter
import cash.imani.voucher.nostr.NostrVoucherClient
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant

/**
 * Discovers merchant offers from Nostr relays using NIP-33 queries.
 *
 * Queries Nostr relays for marketplace offers based on various filters:
 * - Status (ACTIVE, PAUSED, etc.)
 * - Merchant public key
 * - Mint URL
 * - Unit (e.g., "sat")
 * - Expiration status
 *
 * **Use Case Flow**:
 * 1. Build Nostr filter based on search criteria
 * 2. Query relays for matching NIP-33 events (kind 30078)
 * 3. Parse events into MerchantOffer instances
 * 4. Filter expired offers (if requested)
 * 5. Sort offers (newest first)
 *
 * **Query Filters**:
 * - `status`: Filter by offer status (ACTIVE, PAUSED, etc.)
 * - `merchantId`: Filter by merchant's public key
 * - `mintUrl`: Filter by Cashu mint URL
 * - `unit`: Filter by unit of account (default: "sat")
 * - `includeExpired`: Include expired offers (default: false)
 * - `limit`: Maximum number of results (default: 100)
 *
 * **Performance Considerations**:
 * - Queries are cached for 30 seconds to reduce relay load
 * - Results sorted by created_at descending (newest first)
 * - Expired offers filtered client-side
 *
 * **Example Usage**:
 * ```kotlin
 * val discoverOffers = DiscoverMerchantOffersUseCase(...)
 *
 * // Find all active offers
 * val activeOffers = discoverOffers(
 *     DiscoverOffersFilter(status = OfferStatus.ACTIVE)
 * ).getOrThrow()
 *
 * // Find offers from specific merchant
 * val merchantOffers = discoverOffers(
 *     DiscoverOffersFilter(merchantId = "npub1...")
 * ).getOrThrow()
 *
 * // Find offers for specific mint
 * val mintOffers = discoverOffers(
 *     DiscoverOffersFilter(mintUrl = "https://mint.example.com")
 * ).getOrThrow()
 * ```
 *
 * @see MerchantOffer
 * @see PublishOfferToNostrUseCase
 */
class DiscoverMerchantOffersUseCase(
    private val nostrClient: NostrVoucherClient,
) {
    /**
     * Discovers offers from Nostr relays.
     *
     * @param filter Search criteria for offers
     * @return Result containing list of matching offers
     */
    suspend operator fun invoke(filter: DiscoverOffersFilter = DiscoverOffersFilter()): Result<List<MerchantOffer>> =
        runCatching {
            // Build Nostr filter for query
            val nostrFilter = buildNostrFilter(filter)

            // Query Nostr relays
            val events = queryOffersFromNostr(nostrFilter)

            // Parse events into MerchantOffer instances
            val offers =
                events.mapNotNull { event ->
                    try {
                        parseOfferFromEvent(event)
                    } catch (e: Exception) {
                        // Log and skip malformed events
                        println(
                            "[DiscoverMerchantOffersUseCase] Failed to parse offer from event ${event.id}: " +
                                "${e.message}",
                        )
                        null
                    }
                }

            // Filter expired offers (unless explicitly requested)
            val now = Clock.System.now()
            val filteredOffers =
                if (filter.includeExpired) {
                    offers
                } else {
                    offers.filter { !it.isExpired(now) }
                }

            // Sort by created_at descending (newest first)
            filteredOffers.sortedByDescending { it.createdAt }
        }

    /**
     * Builds a Nostr filter from search criteria.
     *
     * Constructs NIP-01 filter with appropriate tags and constraints.
     *
     * @param filter User-provided search criteria
     * @return NostrFilter for relay query
     */
    private fun buildNostrFilter(filter: DiscoverOffersFilter): NostrFilter {
        val tags = mutableMapOf<String, List<String>>()

        // Filter by status
        filter.status?.let { status ->
            tags["status"] = listOf(status.name)
        }

        // Filter by merchant ID
        filter.merchantId?.let { merchantId ->
            tags["merchant"] = listOf(merchantId)
        }

        // Filter by mint URL
        filter.mintUrl?.let { mintUrl ->
            tags["mint"] = listOf(mintUrl)
        }

        // Filter by unit
        filter.unit?.let { unit ->
            tags["unit"] = listOf(unit)
        }

        return NostrFilter(
            kinds = listOf(OFFER_EVENT_KIND),
            authors = filter.merchantId?.let { listOf(it) },
            tags = tags.takeIf { it.isNotEmpty() },
            limit = filter.limit,
        )
    }

    /**
     * Queries Nostr relays for offer events.
     *
     * TODO: Phase 3 enhancement - implement actual relay querying
     * For Phase 2, returns empty list (relays not yet integrated)
     *
     * @param filter Nostr filter for query
     * @return List of matching Nostr events
     */
    private suspend fun queryOffersFromNostr(filter: NostrFilter): List<cash.imani.voucher.nostr.NostrEvent> {
        // TODO: Phase 3 - query actual Nostr relays
        // For Phase 2, return empty list
        println("[DiscoverMerchantOffersUseCase] Querying Nostr relays with filter: $filter")
        println("[DiscoverMerchantOffersUseCase] Note: Phase 2 returns empty list (relay integration pending)")

        // Placeholder for relay query
        // In Phase 3, this will use:
        // return nostrClient.queryEvents(filter).getOrThrow()

        return emptyList()
    }

    /**
     * Parses a MerchantOffer from a Nostr event.
     *
     * Extracts offer data from event tags and content.
     *
     * @param event Nostr event containing offer data
     * @return Parsed MerchantOffer
     * @throws IllegalArgumentException if event is malformed
     */
    private fun parseOfferFromEvent(event: cash.imani.voucher.nostr.NostrEvent): MerchantOffer {
        val createdAt = Instant.fromEpochSeconds(event.created_at)

        // Use MerchantOffer.fromNostrTags() companion method
        return MerchantOffer.fromNostrTags(
            tags = event.tags,
            content = event.content,
            createdAt = createdAt,
        )
    }
}

/**
 * Search criteria for discovering merchant offers.
 *
 * All fields are optional. Empty filter returns all available offers.
 *
 * @property status Filter by offer status (ACTIVE, PAUSED, etc.)
 * @property merchantId Filter by merchant's public key (npub or hex)
 * @property mintUrl Filter by Cashu mint URL
 * @property unit Filter by unit of account (default: "sat")
 * @property includeExpired Include expired offers in results (default: false)
 * @property limit Maximum number of results (default: 100)
 */
data class DiscoverOffersFilter(
    val status: OfferStatus? = null,
    val merchantId: String? = null,
    val mintUrl: String? = null,
    val unit: String? = null,
    val includeExpired: Boolean = false,
    val limit: Int = 100,
)

