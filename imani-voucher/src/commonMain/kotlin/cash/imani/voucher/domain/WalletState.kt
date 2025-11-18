package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.Serializable

/**
 * Represents the complete state of a wallet including vouchers and proofs.
 *
 * @property vouchers List of stored vouchers
 * @property proofs List of unspent proofs available for creating new vouchers
 * @property lastUpdated Timestamp of last state update
 */
@Serializable
data class WalletState(
    val vouchers: List<StoredVoucher>,
    val proofs: List<Proof>,
    @Contextual
    val lastUpdated: Instant
) {
    /**
     * Calculates total balance across all unspent proofs by unit.
     */
    fun getTotalBalance(): Map<String, Long> {
        // Group proofs by their keyset's unit (would need keyset info)
        // For now, return empty map as placeholder
        return emptyMap()
    }

    /**
     * Gets all active (issued and not expired) vouchers.
     */
    fun getActiveVouchers(): List<StoredVoucher> {
        return vouchers.filter { it.isActive() }
    }

    /**
     * Gets total value of all active vouchers by unit.
     */
    fun getActiveVoucherValue(): Map<String, Long> {
        return vouchers
            .filter { it.isActive() }
            .groupBy { it.unit }
            .mapValues { (_, voucherList) ->
                voucherList.sumOf { it.faceValue }
            }
    }
}
