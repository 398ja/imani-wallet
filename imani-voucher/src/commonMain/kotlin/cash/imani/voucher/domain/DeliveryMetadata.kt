package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.Serializable

/**
 * Metadata about how a voucher was delivered.
 *
 * @property method Delivery method used (e.g., "qr", "url", "nostr")
 * @property deliveredAt Timestamp when voucher was delivered
 * @property recipientPubkey Optional recipient's public key (for identity-locked vouchers)
 * @property relayUrls Nostr relay URLs used for delivery (if applicable)
 */
@Serializable
data class DeliveryMetadata(
    val method: String,
    @Contextual
    val deliveredAt: Instant,
    val recipientPubkey: String? = null,
    val relayUrls: List<String>? = null
)
