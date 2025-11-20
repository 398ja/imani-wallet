package cash.imani.voucher.domain

import kotlinx.datetime.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.Serializable

/**
 * Sales metrics for voucher analysis and merchant dashboards.
 *
 * Provides aggregated statistics about voucher issuance, redemption, and revenue
 * over a specified time period. Used by merchants to track business performance.
 *
 * **Use Cases**:
 * - Merchant dashboard analytics
 * - Sales performance tracking
 * - Offer effectiveness analysis
 * - Revenue reporting
 *
 * **Example**:
 * ```kotlin
 * val metrics = SalesMetrics(
 *     totalVouchersIssued = 100,
 *     totalVouchersRedeemed = 85,
 *     totalRevenue = 850_000, // sats
 *     redemptionRate = 0.85, // 85%
 *     salesByOffer = mapOf(
 *         "offer-1" to OfferSales(50, 45, 450_000),
 *         "offer-2" to OfferSales(50, 40, 400_000)
 *     ),
 *     periodStart = Instant.parse("2025-01-01T00:00:00Z"),
 *     periodEnd = Instant.parse("2025-01-31T23:59:59Z")
 * )
 * println("Redemption rate: ${metrics.redemptionRate * 100}%")
 * ```
 *
 * @property totalVouchersIssued Total number of vouchers issued in period
 * @property totalVouchersRedeemed Total number of vouchers redeemed in period
 * @property totalRevenue Total revenue from redeemed vouchers (in sats)
 * @property redemptionRate Percentage of issued vouchers that were redeemed (0.0-1.0)
 * @property salesByOffer Sales metrics grouped by offer ID
 * @property periodStart Start of the metrics period (inclusive)
 * @property periodEnd End of the metrics period (inclusive)
 *
 * @see OfferSales Sales metrics for individual offers
 * @see GetSalesMetricsUseCase Use case that computes these metrics
 */
@Serializable
data class SalesMetrics(
    val totalVouchersIssued: Int,
    val totalVouchersRedeemed: Int,
    val totalRevenue: Long, // sats
    val redemptionRate: Double, // 0.0-1.0
    val salesByOffer: Map<String, OfferSales> = emptyMap(), // offerId -> stats
    @Contextual val periodStart: Instant,
    @Contextual val periodEnd: Instant,
) {
    /**
     * Calculates average voucher value.
     *
     * @return Average value per voucher in sats, or 0 if no vouchers redeemed
     */
    fun averageVoucherValue(): Long =
        if (totalVouchersRedeemed > 0) {
            totalRevenue / totalVouchersRedeemed
        } else {
            0
        }

    /**
     * Validates metrics data consistency.
     *
     * @return true if metrics are valid
     */
    fun isValid(): Boolean =
        totalVouchersIssued >= 0 &&
            totalVouchersRedeemed >= 0 &&
            totalVouchersRedeemed <= totalVouchersIssued &&
            totalRevenue >= 0 &&
            redemptionRate in 0.0..1.0 &&
            periodStart <= periodEnd
}

/**
 * Sales metrics for a specific voucher offer.
 *
 * Tracks performance of individual offers to help merchants understand
 * which products/services are most popular and profitable.
 *
 * **Example**:
 * ```kotlin
 * val offerSales = OfferSales(
 *     vouchersIssued = 50,
 *     vouchersRedeemed = 45,
 *     revenue = 450_000 // sats
 * )
 * println("Redemption rate: ${offerSales.redemptionRate() * 100}%")
 * println("Average value: ${offerSales.averageValue()} sats")
 * ```
 *
 * @property vouchersIssued Number of vouchers issued for this offer
 * @property vouchersRedeemed Number of vouchers redeemed for this offer
 * @property revenue Total revenue from this offer (in sats)
 *
 * @see SalesMetrics Overall sales metrics including all offers
 */
@Serializable
data class OfferSales(
    val vouchersIssued: Int,
    val vouchersRedeemed: Int,
    val revenue: Long, // sats
) {
    /**
     * Calculates redemption rate for this offer.
     *
     * @return Redemption rate (0.0-1.0), or 0.0 if no vouchers issued
     */
    fun redemptionRate(): Double =
        if (vouchersIssued > 0) {
            vouchersRedeemed.toDouble() / vouchersIssued.toDouble()
        } else {
            0.0
        }

    /**
     * Calculates average voucher value for this offer.
     *
     * @return Average value per voucher in sats, or 0 if no vouchers redeemed
     */
    fun averageValue(): Long =
        if (vouchersRedeemed > 0) {
            revenue / vouchersRedeemed
        } else {
            0
        }

    /**
     * Validates offer sales data consistency.
     *
     * @return true if data is valid
     */
    fun isValid(): Boolean =
        vouchersIssued >= 0 &&
            vouchersRedeemed >= 0 &&
            vouchersRedeemed <= vouchersIssued &&
            revenue >= 0
}
