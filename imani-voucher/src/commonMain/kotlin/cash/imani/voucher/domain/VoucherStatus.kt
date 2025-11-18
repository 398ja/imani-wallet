package cash.imani.voucher.domain

import kotlinx.serialization.Serializable

/**
 * Represents the lifecycle status of a voucher.
 */
@Serializable
enum class VoucherStatus {
    /** Voucher has been issued but not yet delivered */
    ISSUED,

    /** Voucher has been delivered to recipient */
    DELIVERED,

    /** Voucher has been redeemed */
    REDEEMED,

    /** Voucher has been revoked by issuer */
    REVOKED,

    /** Voucher has expired (past expiration date) */
    EXPIRED
}
