package cash.imani.identity.domain

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.util.hexToBytes
import cash.imani.identity.util.toHex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray

/**
 * Represents an unsigned Nostr event per NIP-01.
 *
 * Nostr events are the fundamental data structure of the Nostr protocol.
 * All events must be signed before being broadcast to relays.
 *
 * Specification: https://github.com/nostr-protocol/nips/blob/master/01.md
 *
 * @property pubkey 32-byte public key (hex-encoded, 64 characters)
 * @property created_at Unix timestamp in seconds
 * @property kind Event kind (0=profile, 1=text note, 4=encrypted DM, etc.)
 * @property tags Array of tags (each tag is array of strings)
 * @property content Event content (text, JSON, or encrypted data)
 */
@Serializable
data class NostrEvent(
    val pubkey: String,
    val created_at: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String,
) {
    /**
     * Computes the event ID per NIP-01.
     *
     * Event ID = SHA-256 of serialized event array:
     * [0, pubkey, created_at, kind, tags, content]
     *
     * @param cryptoAdapter CryptoAdapter for SHA-256 hashing
     * @return 32-byte event ID
     */
    suspend fun computeId(cryptoAdapter: CryptoAdapter): ByteArray {
        // Serialize event as JSON array per NIP-01
        // [0, pubkey, created_at, kind, tags, content]
        val jsonArray =
            buildJsonArray {
                add(0) // Reserved for future use
                add(pubkey)
                add(created_at)
                add(kind)
                add(
                    buildJsonArray {
                        tags.forEach { tag ->
                            add(
                                buildJsonArray {
                                    tag.forEach { add(it) }
                                },
                            )
                        }
                    },
                )
                add(content)
            }

        val serialized = jsonArray.toString()

        // Compute SHA-256 hash
        return cryptoAdapter.sha256(serialized.encodeToByteArray())
    }

    /**
     * Common Nostr event kinds per NIP-01.
     */
    object Kind {
        const val METADATA = 0 // User profile (NIP-01)
        const val TEXT_NOTE = 1 // Short text note (NIP-01)
        const val RECOMMEND_RELAY = 2 // Relay recommendation (NIP-01)
        const val CONTACTS = 3 // Contact list (NIP-02)
        const val ENCRYPTED_DM = 4 // Encrypted direct message (NIP-04)
        const val DELETE = 5 // Event deletion request (NIP-09)
        const val REPOST = 6 // Event repost (NIP-18)
        const val REACTION = 7 // Reaction/like (NIP-25)
        const val CHANNEL_CREATE = 40 // Channel creation (NIP-28)
        const val CHANNEL_METADATA = 41 // Channel metadata (NIP-28)
        const val CHANNEL_MESSAGE = 42 // Channel message (NIP-28)
        const val CHANNEL_HIDE_MESSAGE = 43 // Hide message (NIP-28)
        const val CHANNEL_MUTE_USER = 44 // Mute user (NIP-28)
    }
}

/**
 * Represents a signed Nostr event ready for broadcast.
 *
 * @property event The original unsigned event
 * @property id Event ID (32-byte SHA-256 hash, hex-encoded)
 * @property sig Schnorr signature (64-byte, hex-encoded)
 */
@Serializable
data class SignedNostrEvent(
    val id: String,
    val pubkey: String,
    val created_at: Long,
    val kind: Int,
    val tags: List<List<String>>,
    val content: String,
    val sig: String,
) {
    /**
     * Validates the signature of this event.
     *
     * @param cryptoAdapter CryptoAdapter for Schnorr verification
     * @return true if signature is valid, false otherwise
     */
    suspend fun verifySignature(cryptoAdapter: CryptoAdapter): Boolean {
        return try {
            // Reconstruct event for ID computation
            val event =
                NostrEvent(
                    pubkey = pubkey,
                    created_at = created_at,
                    kind = kind,
                    tags = tags,
                    content = content,
                )

            // Compute event ID
            val computedId = event.computeId(cryptoAdapter)

            // Verify computed ID matches stored ID
            if (computedId.toHex() != id) {
                return false
            }

            // Verify Schnorr signature
            cryptoAdapter.schnorrVerify(
                publicKey = pubkey.hexToBytes(),
                message = id.hexToBytes(),
                signature = sig.hexToBytes(),
            )
        } catch (e: Exception) {
            false
        }
    }

    companion object {
        /**
         * Creates a SignedNostrEvent from an unsigned event and signature.
         */
        suspend fun create(
            event: NostrEvent,
            signature: ByteArray,
            cryptoAdapter: CryptoAdapter,
        ): SignedNostrEvent {
            val eventId = event.computeId(cryptoAdapter)
            return SignedNostrEvent(
                id = eventId.toHex(),
                pubkey = event.pubkey,
                created_at = event.created_at,
                kind = event.kind,
                tags = event.tags,
                content = event.content,
                sig = signature.toHex(),
            )
        }
    }
}
