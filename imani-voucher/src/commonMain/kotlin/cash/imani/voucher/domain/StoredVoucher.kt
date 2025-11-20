package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Represents a stored voucher with full lifecycle metadata.
 *
 * A voucher is a transferable value token backed by Cashu proofs,
 * signed by an issuer identity for authenticity.
 *
 * Serialization: Uses @SerialName annotations for explicit JSON field names,
 * ensuring compatibility with:
 * - cashu-client Java VoucherRecord (JVM interop)
 * - Nostr NIP-33 events (kind 30078 parameterized replaceable events)
 * - Web IndexedDB storage
 *
 * @property voucherId Unique identifier for this voucher
 * @property issuerId Identity ID of the voucher issuer
 * @property unit Unit of account (e.g., "sat" for satoshis)
 * @property faceValue Stated value of the voucher
 * @property expiresAt Optional expiration timestamp (epoch seconds)
 * @property memo Optional human-readable memo/description
 * @property issuerSignature Schnorr signature from issuer's identity key
 * @property issuerPublicKey Hex-encoded public key of the issuer
 * @property issuedAt Timestamp when voucher was issued
 * @property status Current lifecycle status of the voucher
 * @property token Optional encoded Cashu token (V4 CBOR format)
 * @property deliveryMetadata Metadata about voucher delivery
 * @property redemptionMetadata Metadata about voucher redemption
 */
@Serializable
data class StoredVoucher(
    @SerialName("voucherId")
    val voucherId: String,
    @SerialName("issuerId")
    val issuerId: String,
    @SerialName("unit")
    val unit: String,
    @SerialName("faceValue")
    val faceValue: Long,
    @SerialName("expiresAt")
    val expiresAt: Long? = null,
    @SerialName("memo")
    val memo: String? = null,
    @SerialName("issuerSignature")
    val issuerSignature: String,
    @SerialName("issuerPublicKey")
    val issuerPublicKey: String,
    @SerialName("issuedAt")
    @Contextual
    val issuedAt: Instant,
    @SerialName("status")
    val status: VoucherStatus,
    @SerialName("token")
    val token: String? = null,
    @SerialName("deliveryMetadata")
    val deliveryMetadata: DeliveryMetadata? = null,
    @SerialName("redemptionMetadata")
    val redemptionMetadata: RedemptionMetadata? = null,
) {
    /**
     * Checks if the voucher has expired based on current time.
     */
    fun isExpired(): Boolean {
        return expiresAt?.let { it < kotlinx.datetime.Clock.System.now().epochSeconds } ?: false
    }

    /**
     * Checks if the voucher is currently active (issued and not expired).
     */
    fun isActive(): Boolean {
        return status == VoucherStatus.ISSUED && !isExpired()
    }

    /**
     * Checks if the voucher can be redeemed.
     */
    fun canRedeem(): Boolean {
        return status in listOf(VoucherStatus.ISSUED, VoucherStatus.DELIVERED) && !isExpired()
    }
}
