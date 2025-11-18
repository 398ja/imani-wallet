package cash.imani.identity.domain

import cash.imani.identity.util.Bech32
import cash.imani.identity.util.hexToBytes
import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.Serializable
import kotlin.time.Duration.Companion.days

/**
 * Domain entity representing a Nostr identity.
 *
 * Kotlin Multiplatform adaptation of xyz.tcheeric.identity.domain.Identity.
 * This entity adds business logic for identity management:
 * - Identity management (ID, label, timestamps)
 * - Activity tracking (active/dormant status)
 *
 * INTENTIONAL DIFFERENCES FROM JAVA VERSION:
 * - publicKey/privateKey stored as hex strings (KMP-friendly vs byte arrays)
 * - lastUsedAt is immutable (use withUpdatedUsage() to update)
 * - No nostr-java dependency (crypto delegated to platform-specific implementations)
 *
 * @property id Unique identifier for this identity
 * @property label Human-readable label for the identity (1-100 characters)
 * @property publicKey Hex-encoded secp256k1 public key (32 bytes = 64 hex chars, Nostr standard)
 * @property privateKey Hex-encoded secp256k1 private key (32 bytes = 64 hex chars)
 * @property createdAt Timestamp when the identity was created
 * @property lastUsedAt Timestamp when the identity was last used (null if never used)
 */
@Serializable
data class Identity(
    val id: String,
    val label: String,
    // Hex-encoded (64 chars)
    val publicKey: String,
    // Hex-encoded (64 chars) - SECURITY: Handle with care
    val privateKey: String,
    @Contextual
    val createdAt: Instant,
    @Contextual
    val lastUsedAt: Instant?,
) {
    init {
        require(id.isNotBlank()) { "Identity ID cannot be blank" }
        require(label.trim().length in 1..100) {
            "Identity label must be 1-100 characters, got ${label.trim().length}"
        }
        require(publicKey.length == 64) {
            "Public key must be 64 hex characters (32 bytes), got ${publicKey.length}"
        }
        require(privateKey.length == 64) {
            "Private key must be 64 hex characters (32 bytes), got ${privateKey.length}"
        }
    }

    /**
     * Converts the public key to Nostr npub format (bech32-encoded).
     */
    fun toNpub(): String {
        return Bech32.encode("npub", publicKey.hexToBytes())
    }

    /**
     * Checks if the identity has been used within the last 90 days.
     * An identity is considered active if it was used in the last 90 days,
     * or if it has never been used but was created in the last 90 days.
     */
    fun isActive(): Boolean {
        val referenceTime = lastUsedAt ?: createdAt
        val ninetyDaysAgo = kotlinx.datetime.Clock.System.now().minus(90.days)
        return referenceTime > ninetyDaysAgo
    }

    /**
     * Checks if the identity is dormant (opposite of active).
     */
    fun isDormant(): Boolean = !isActive()

    /**
     * Returns a new Identity with an updated label.
     * Follows immutability pattern for domain entities.
     */
    fun withLabel(newLabel: String): Identity {
        return copy(label = newLabel)
    }

    /**
     * Returns a new Identity with updated lastUsedAt timestamp.
     * Call this when the identity performs an operation (sign, encrypt, etc.).
     */
    fun withUpdatedUsage(): Identity {
        return copy(lastUsedAt = kotlinx.datetime.Clock.System.now())
    }
}
