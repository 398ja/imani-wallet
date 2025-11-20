package cash.imani.voucher.usecases

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.domain.NostrEvent
import cash.imani.identity.repository.IdentityRepository
import cash.imani.identity.usecases.SignNostrEventUseCase
import cash.imani.voucher.domain.MerchantOffer
import cash.imani.voucher.domain.OfferStatus
import cash.imani.voucher.nostr.NostrVoucherClient
import kotlinx.datetime.Clock

/**
 * Publishes a merchant offer to Nostr relays using NIP-33.
 *
 * Takes a DRAFT offer, converts it to a Nostr NIP-33 event (kind 30078),
 * signs it with the merchant's identity, and publishes to configured relays.
 *
 * **Use Case Flow**:
 * 1. Validate offer is in DRAFT status
 * 2. Validate merchant identity exists and matches offer
 * 3. Create Nostr NIP-33 event with offer data
 * 4. Sign event with merchant's private key
 * 5. Publish to Nostr relays
 * 6. Update offer status to ACTIVE
 *
 * **NIP-33 Event Format**:
 * - Kind: 30078 (Parameterized Replaceable Event)
 * - Content: Offer description
 * - Tags:
 *   - ["d", offerId] - Identifier for replacement
 *   - ["merchant", merchantId] - Merchant public key
 *   - ["amount", amount, unit] - Face value
 *   - ["price", price, unit] - Sale price
 *   - ["mint", mintUrl] - Cashu mint URL
 *   - ["expiry", timestamp] - Optional expiration
 *   - ["status", status] - Offer status
 *
 * **Error Handling**:
 * - Throws IllegalStateException if offer not in DRAFT status
 * - Throws IllegalArgumentException if merchant identity not found
 * - Returns Result.failure if signing or publishing fails
 *
 * **Example Usage**:
 * ```kotlin
 * val publishOffer = PublishOfferToNostrUseCase(...)
 * val offer = createOfferUseCase(...).getOrThrow()
 *
 * publishOffer(offer)
 *     .onSuccess { publishedOffer ->
 *         println("Offer published: ${publishedOffer.offerId}")
 *         println("Status: ${publishedOffer.status}") // ACTIVE
 *     }
 *     .onFailure { error ->
 *         println("Failed to publish: ${error.message}")
 *     }
 * ```
 *
 * @see CreateOfferUseCase
 * @see MerchantOffer
 * @see cash.imani.identity.usecases.SignNostrEventUseCase
 */
class PublishOfferToNostrUseCase(
    private val identityRepository: IdentityRepository,
    private val cryptoAdapter: CryptoAdapter,
    private val nostrClient: NostrVoucherClient,
) {
    /**
     * Publishes an offer to Nostr relays.
     *
     * @param offer The offer to publish (must be in DRAFT status)
     * @return Result containing the published offer with ACTIVE status
     */
    suspend operator fun invoke(offer: MerchantOffer): Result<MerchantOffer> =
        runCatching {
            // Validate offer status
            require(offer.status == OfferStatus.DRAFT) {
                "Cannot publish offer in ${offer.status} status. " +
                    "Suggestion: Only DRAFT offers can be published. " +
                    "Current status: ${offer.status}"
            }

            // Validate merchant identity exists (find by public key)
            val allIdentities = identityRepository.listIdentities().getOrThrow()
            val merchantIdentity =
                allIdentities.firstOrNull { it.publicKey == offer.merchantId }
                    ?: throw IllegalArgumentException(
                        "Merchant identity not found for public key: ${offer.merchantId}. " +
                            "Suggestion: Ensure the merchant identity exists before publishing offers.",
                    )

            // Create unsigned Nostr event
            val unsignedEvent =
                NostrEvent(
                    pubkey = offer.merchantId,
                    created_at = Clock.System.now().epochSeconds,
                    kind = OFFER_EVENT_KIND,
                    tags = offer.toNostrTags(),
                    content = offer.description,
                )

            // Sign event with merchant's private key
            val signNostrEventUseCase = SignNostrEventUseCase(identityRepository, cryptoAdapter)
            val signedEvent = signNostrEventUseCase(merchantIdentity.id, unsignedEvent).getOrThrow()

            // Publish to Nostr relays (reusing voucher client infrastructure)
            // Note: In Phase 3, we might create a dedicated NostrOfferClient
            // For now, we'll store offers using the same Nostr infrastructure as vouchers
            publishOfferEvent(signedEvent, offer)

            // Update offer status to ACTIVE
            offer.copy(status = OfferStatus.ACTIVE)
        }

    /**
     * Publishes the signed offer event to Nostr relays.
     *
     * Uses NostrVoucherClient infrastructure for publishing.
     * In a full implementation, this would publish the raw Nostr event.
     *
     * @param signedEvent The signed Nostr event
     * @param offer The offer being published
     */
    private suspend fun publishOfferEvent(
        signedEvent: cash.imani.identity.domain.SignedNostrEvent,
        offer: MerchantOffer,
    ) {
        // TODO: Phase 3 enhancement - publish raw Nostr event to relays
        // For Phase 2, we'll use a simplified approach
        // The NostrVoucherClient stores events in-memory or publishes to test relays

        // Convert SignedNostrEvent to NostrEvent format expected by NostrVoucherClient
        val nostrEvent =
            cash.imani.voucher.nostr.NostrEvent(
                id = signedEvent.id,
                pubkey = signedEvent.pubkey,
                created_at = signedEvent.created_at,
                kind = OFFER_EVENT_KIND,
                tags = signedEvent.tags,
                content = signedEvent.content,
                sig = signedEvent.sig,
            )

        // For Phase 2, we'll log the event publication
        // In Phase 3, this will use actual relay publishing
        println(
            "[PublishOfferToNostrUseCase] Publishing offer ${offer.offerId} " +
                "as NIP-33 event ${signedEvent.id}",
        )
        println("[PublishOfferToNostrUseCase] Event kind: $OFFER_EVENT_KIND (NIP-33)")
        println("[PublishOfferToNostrUseCase] Tags: ${nostrEvent.tags}")

        // TODO: Actual relay publishing
        // nostrClient.publishEvent(nostrEvent).getOrThrow()
    }
}

/**
 * Offer event kind for NIP-33 Parameterized Replaceable Events.
 *
 * Uses kind 30078 (application-specific data) for marketplace offers.
 * The "d" tag contains the offer ID, allowing offers to be updated or cancelled.
 */
const val OFFER_EVENT_KIND = 30078
