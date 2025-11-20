package cash.imani.voucher.network

import cash.imani.voucher.domain.Proof
import kotlinx.serialization.Serializable

/**
 * Cashu Mint API data models.
 *
 * Based on Cashu NUTs (Notation, Usage, and Terminology):
 * - NUT-00: Cryptography and Models
 * - NUT-01: Mint public keys
 * - NUT-02: Keysets and keyset IDs
 * - NUT-03: Swap tokens
 * - NUT-07: Token state check
 */

/**
 * Mint information response (NUT-06).
 *
 * @property name Short name of the mint
 * @property pubkey Hex-encoded public key of the mint
 * @property version Cashu version supported
 * @property description Short description
 * @property description_long Optional long description
 * @property contact Contact information list
 * @property motd Message of the day
 * @property nuts Supported NUTs and their settings
 */
@Serializable
data class MintInfo(
    val name: String,
    val pubkey: String,
    val version: String,
    val description: String,
    val description_long: String? = null,
    val contact: List<ContactInfo> = emptyList(),
    val motd: String? = null,
    val nuts: Map<String, NutInfo>,
)

/**
 * Contact information for a mint.
 */
@Serializable
data class ContactInfo(
    // "email", "twitter", "nostr", etc.
    val method: String,
    // The actual contact (email address, handle, npub, etc.)
    val info: String,
)

/**
 * NUT-specific settings.
 */
@Serializable
data class NutInfo(
    val supported: Boolean = true,
    val methods: List<String> = emptyList(),
    val disabled: Boolean = false,
)

/**
 * Response containing available keysets (NUT-02).
 */
@Serializable
data class KeySetsResponse(
    val keysets: List<KeySet>,
)

/**
 * A keyset contains the mint's public keys for blind signatures (NUT-02).
 *
 * @property id Keyset ID (hex-encoded)
 * @property unit Unit of account (e.g., "sat" for satoshis)
 * @property active Whether this keyset is currently active
 * @property keys Map of amount to public key (hex-encoded)
 */
@Serializable
data class KeySet(
    val id: String,
    val unit: String,
    val active: Boolean,
    val keys: Map<Int, String>,
)

/**
 * Request to swap proofs for new ones (NUT-03).
 *
 * @property inputs Proofs to be spent
 * @property outputs Blinded messages for new proofs
 */
@Serializable
data class SwapRequest(
    val inputs: List<Proof>,
    val outputs: List<BlindedMessage>,
)

/**
 * Blinded message for blind signature request.
 *
 * @property amount Amount for this output
 * @property id Keyset ID to sign with
 * @property B_ Blinded message (point on curve, hex-encoded)
 */
@Serializable
data class BlindedMessage(
    val amount: Int,
    val id: String,
    // Blinded secret
    val B_: String,
)

/**
 * Response from swap operation (NUT-03).
 *
 * @property signatures Blind signatures for the outputs
 */
@Serializable
data class SwapResponse(
    val signatures: List<BlindSignature>,
)

/**
 * Blind signature from the mint.
 *
 * @property amount Amount this signature is for
 * @property id Keyset ID used
 * @property C_ Blinded signature (point on curve, hex-encoded)
 */
@Serializable
data class BlindSignature(
    val amount: Int,
    val id: String,
    // Blinded signature
    val C_: String,
)

/**
 * Request to check proof states (NUT-07).
 *
 * @property Ys List of Y values (hash-to-curve of secrets, hex-encoded)
 */
@Serializable
data class CheckStateRequest(
    val Ys: List<String>,
)

/**
 * Response with proof states (NUT-07).
 *
 * @property states List of proof states
 */
@Serializable
data class ProofStateResponse(
    val states: List<ProofState>,
)

/**
 * State of a single proof.
 *
 * @property Y The Y value (hash of secret)
 * @property state Current state: "UNSPENT", "PENDING", or "SPENT"
 * @property witness Optional witness data
 */
@Serializable
data class ProofState(
    val Y: String,
    val state: String,
    val witness: String? = null,
)

// ==================== NUT-04: Minting Tokens (Lightning) ====================

/**
 * Request to create a mint quote for Lightning payment (NUT-04).
 *
 * POST /v1/mint/quote/bolt11
 *
 * @property amount Amount in specified unit (e.g., satoshis)
 * @property unit Unit of account (e.g., "sat")
 */
@Serializable
data class MintQuoteRequest(
    val amount: Int,
    val unit: String,
)

/**
 * Response from creating a mint quote (NUT-04).
 *
 * Contains the quote ID and Lightning invoice for payment.
 *
 * @property quote Quote ID used for minting after payment
 * @property request BOLT11 Lightning invoice string (lnbc...)
 * @property paid Whether the invoice has been paid
 * @property expiry Expiration timestamp (Unix seconds)
 */
@Serializable
data class MintQuoteResponse(
    val quote: String,
    val request: String,
    val paid: Boolean,
    val expiry: Long,
)
