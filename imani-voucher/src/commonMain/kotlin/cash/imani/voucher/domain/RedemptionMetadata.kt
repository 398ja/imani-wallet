package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.Serializable

/**
 * Metadata about how a voucher was redeemed.
 *
 * @property redeemedAt Timestamp when voucher was redeemed
 * @property redeemedBy Public key of the redeemer (if known)
 * @property amountReceived Actual amount received after redemption (may differ from face value)
 * @property transactionId Optional transaction/quote ID from the mint
 */
@Serializable
data class RedemptionMetadata(
    @Contextual
    val redeemedAt: Instant,
    val redeemedBy: String? = null,
    val amountReceived: Long,
    val transactionId: String? = null
)
