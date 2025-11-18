package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.Serializable

/**
 * Represents a stored voucher with full lifecycle metadata.
 *
 * A voucher is a transferable value token backed by Cashu proofs,
 * signed by an issuer identity for authenticity.
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
    val voucherId: String,
    val issuerId: String,
    val unit: String,
    val faceValue: Long,
    val expiresAt: Long? = null,
    val memo: String? = null,
    val issuerSignature: String,
    val issuerPublicKey: String,
    @Contextual
    val issuedAt: Instant,
    val status: VoucherStatus,
    val token: String? = null,
    val deliveryMetadata: DeliveryMetadata? = null,
    val redemptionMetadata: RedemptionMetadata? = null
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
