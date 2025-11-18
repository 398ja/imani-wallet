package cash.imani.voucher.nostr

import kotlinx.serialization.Serializable

/**
 * Nostr event following NIP-01 specification.
 *
 * This is a simplified model for voucher storage. For full Nostr functionality,
 * use a dedicated Nostr library.
 *
 * @property id Event ID (32-byte hex string, computed from event data)
 * @property pubkey Author's public key (32-byte hex string)
 * @property created_at Unix timestamp in seconds
 * @property kind Event kind (30078 for vouchers - NIP-33)
 * @property tags Array of tags (each tag is an array of strings)
 * @property content Event content (JSON-encoded voucher data)
 * @property sig Schnorr signature (64-byte hex string)
 */
@Serializable
data class NostrEvent(
    val id: String,
    val pubkey: String,
    val created_at: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String,
    val sig: String
)

/**
 * Unsigned Nostr event template.
 *
 * Used to construct an event before signing.
 */
@Serializable
data class UnsignedNostrEvent(
    val pubkey: String,
    val created_at: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String
) {
    /**
     * Computes the event ID according to NIP-01.
     *
     * The ID is the SHA-256 hash of the serialized event data.
     * Serialization format: [0, pubkey, created_at, kind, tags, content]
     */
    fun computeId(): String {
        // This will be implemented platform-specifically using crypto adapters
        // For now, return placeholder
        throw NotImplementedError("Event ID computation requires crypto adapter")
    }
}

/**
 * Nostr filter for querying events (NIP-01).
 *
 * @property ids List of event IDs to match
 * @property authors List of author public keys to match
 * @property kinds List of event kinds to match
 * @property since Unix timestamp - only events after this time
 * @property until Unix timestamp - only events before this time
 * @property limit Maximum number of events to return
 * @property tags Tag filters (e.g., "#d" for NIP-33 identifier)
 */
@Serializable
data class NostrFilter(
    val ids: List<String>? = null,
    val authors: List<String>? = null,
    val kinds: List<Int>? = null,
    val since: Long? = null,
    val until: Long? = null,
    val limit: Int? = null,
    val tags: Map<String, List<String>>? = null
)

/**
 * Voucher event kind for NIP-33 Parameterized Replaceable Events.
 */
const val VOUCHER_EVENT_KIND = 30078
