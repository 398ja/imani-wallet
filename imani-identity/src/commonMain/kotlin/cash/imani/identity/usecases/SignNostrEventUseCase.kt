package cash.imani.identity.usecases

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.domain.NostrEvent
import cash.imani.identity.domain.SignedNostrEvent
import cash.imani.identity.repository.IdentityRepository

/**
 * Use case for signing Nostr events with an identity's private key.
 *
 * Responsibilities:
 * - Validates identity exists
 * - Retrieves private key securely
 * - Computes event ID (SHA-256 of serialized event)
 * - Creates Schnorr signature
 * - Updates identity's lastUsedAt timestamp
 * - Returns signed event ready for broadcast
 *
 * Business Rules:
 * - Event pubkey must match identity's public key
 * - Uses BIP340 Schnorr signatures (Nostr standard)
 * - Event ID computed per NIP-01 specification
 * - Private key held in memory for minimal duration
 *
 * Design: Command pattern with security-focused implementation
 */
class SignNostrEventUseCase(
    private val identityRepository: IdentityRepository,
    private val cryptoAdapter: CryptoAdapter,
) {
    /**
     * Executes the use case to sign a Nostr event.
     *
     * @param identityId ID of the identity to sign with
     * @param event Unsigned Nostr event to sign
     * @return Result containing SignedNostrEvent with id and signature
     */
    suspend operator fun invoke(
        identityId: String,
        event: NostrEvent,
    ): Result<SignedNostrEvent> =
        runCatching {
            // Validate identity exists and get identity
            val identity = identityRepository.getIdentity(identityId).getOrThrow()

            // Validate event pubkey matches identity
            require(event.pubkey == identity.publicKey) {
                "Event pubkey (${event.pubkey}) does not match identity public key (${identity.publicKey})"
            }

            // Retrieve private key (held in memory temporarily)
            val privateKey = identityRepository.getPrivateKey(identityId).getOrThrow()

            try {
                // Compute event ID (SHA-256 of serialized event)
                val eventId = event.computeId(cryptoAdapter)

                // Sign event ID with Schnorr signature
                val signature = cryptoAdapter.schnorrSign(privateKey, eventId)

                // Create signed event
                val signedEvent = SignedNostrEvent.create(event, signature, cryptoAdapter)

                // Update identity's lastUsedAt timestamp
                identityRepository.updateLastUsed(identityId)

                signedEvent
            } finally {
                // Zero out private key from memory (security best practice)
                privateKey.fill(0)
            }
        }

    /**
     * Convenience method to create and sign a text note (kind 1).
     *
     * @param identityId ID of the identity to sign with
     * @param content Text content of the note
     * @param tags Optional tags (e.g., mentions, hashtags)
     * @param createdAt Optional timestamp (defaults to now)
     * @return Result containing SignedNostrEvent
     */
    suspend fun signTextNote(
        identityId: String,
        content: String,
        tags: List<List<String>> = emptyList(),
        createdAt: Long = currentUnixTimestamp(),
    ): Result<SignedNostrEvent> {
        val identity = identityRepository.getIdentity(identityId).getOrThrow()

        val event =
            NostrEvent(
                pubkey = identity.publicKey,
                created_at = createdAt,
                kind = NostrEvent.Kind.TEXT_NOTE,
                tags = tags,
                content = content,
            )

        return invoke(identityId, event)
    }

    /**
     * Gets current Unix timestamp in seconds.
     */
    private fun currentUnixTimestamp(): Long {
        return kotlinx.datetime.Clock.System.now().epochSeconds
    }
}
