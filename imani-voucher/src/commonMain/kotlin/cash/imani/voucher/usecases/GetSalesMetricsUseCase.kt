package cash.imani.voucher.usecases

import cash.imani.voucher.domain.OfferSales
import cash.imani.voucher.domain.SalesMetrics
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.repository.VoucherRepository
import kotlinx.datetime.Instant

/**
 * Use case for retrieving sales metrics over a specified time period.
 *
 * Aggregates voucher data to provide business insights for merchants:
 * - Total vouchers issued and redeemed
 * - Total revenue from voucher sales
 * - Redemption rates (overall and by offer)
 * - Sales breakdown by individual offers
 *
 * **Use Cases**:
 * - Merchant dashboard analytics
 * - Sales performance reports
 * - Offer effectiveness analysis
 * - Business intelligence and forecasting
 *
 * **Example Usage**:
 * ```kotlin
 * val salesMetrics = GetSalesMetricsUseCase(voucherRepository)
 * val metrics = salesMetrics(
 *     periodStart = Instant.parse("2025-01-01T00:00:00Z"),
 *     periodEnd = Instant.parse("2025-01-31T23:59:59Z")
 * ).getOrThrow()
 *
 * println("Total revenue: ${metrics.totalRevenue} sats")
 * println("Redemption rate: ${metrics.redemptionRate * 100}%")
 * println("Top offer: ${metrics.salesByOffer.maxByOrNull { it.value.revenue }?.key}")
 * ```
 *
 * **Metrics Calculated**:
 * - `totalVouchersIssued`: Count of vouchers issued during period
 * - `totalVouchersRedeemed`: Count of vouchers redeemed during period
 * - `totalRevenue`: Sum of face values of redeemed vouchers
 * - `redemptionRate`: Ratio of redeemed to issued (0.0-1.0)
 * - `salesByOffer`: Per-offer breakdown (requires vouchers to have offerId metadata)
 *
 * **Data Sources**:
 * - VoucherRepository: Lists all vouchers with status and timestamps
 * - Filters by issuedAt timestamp for period range
 * - Groups by status (ISSUED, REDEEMED) for aggregation
 *
 * @property voucherRepository Repository for querying voucher data
 *
 * @see SalesMetrics Domain model containing aggregated metrics
 * @see OfferSales Per-offer sales metrics
 */
class GetSalesMetricsUseCase(
    private val voucherRepository: VoucherRepository,
) {
    /**
     * Retrieves sales metrics for the specified time period.
     *
     * **Algorithm**:
     * 1. Query all vouchers from repository
     * 2. Filter vouchers issued within the period (issuedAt between start and end)
     * 3. Count issued vouchers
     * 4. Count redeemed vouchers (status = REDEEMED)
     * 5. Sum revenue from redeemed vouchers (faceValue)
     * 6. Calculate redemption rate (redeemed / issued)
     * 7. Group by offer ID if available (from voucher metadata)
     * 8. Return aggregated SalesMetrics
     *
     * **Edge Cases**:
     * - No vouchers in period: Returns zero metrics
     * - No offers specified: salesByOffer map is empty
     * - Partial redemptions: Only counts fully redeemed vouchers
     *
     * @param periodStart Start of the metrics period (inclusive)
     * @param periodEnd End of the metrics period (inclusive)
     * @return Result containing SalesMetrics or error
     */
    suspend operator fun invoke(
        periodStart: Instant,
        periodEnd: Instant,
    ): Result<SalesMetrics> =
        runCatching {
            require(periodStart <= periodEnd) {
                "Period start ($periodStart) must be before or equal to period end ($periodEnd)"
            }

            // 1. Query all vouchers from repository
            val allVouchers =
                voucherRepository.getAllVouchers().getOrElse {
                    throw VoucherMetricsException("Failed to fetch vouchers: ${it.message}", it)
                }

            // 2. Filter vouchers issued within the period
            val vouchersInPeriod =
                allVouchers.filter { voucher ->
                    voucher.issuedAt >= periodStart && voucher.issuedAt <= periodEnd
                }

            // 3. Count issued vouchers
            val totalVouchersIssued = vouchersInPeriod.size

            // 4. Count redeemed vouchers
            val redeemedVouchers = vouchersInPeriod.filter { it.status == VoucherStatus.REDEEMED }
            val totalVouchersRedeemed = redeemedVouchers.size

            // 5. Sum revenue from redeemed vouchers
            val totalRevenue = redeemedVouchers.sumOf { it.faceValue }

            // 6. Calculate redemption rate
            val redemptionRate =
                if (totalVouchersIssued > 0) {
                    totalVouchersRedeemed.toDouble() / totalVouchersIssued.toDouble()
                } else {
                    0.0
                }

            // 7. Group by offer ID (if vouchers have offer metadata)
            // For Phase 2, we'll use the memo field to encode offerId if present
            // Format: "offer:<offerId>|<description>"
            val salesByOffer = calculateSalesByOffer(vouchersInPeriod)

            // 8. Return aggregated metrics
            SalesMetrics(
                totalVouchersIssued = totalVouchersIssued,
                totalVouchersRedeemed = totalVouchersRedeemed,
                totalRevenue = totalRevenue,
                redemptionRate = redemptionRate,
                salesByOffer = salesByOffer,
                periodStart = periodStart,
                periodEnd = periodEnd,
            )
        }

    /**
     * Calculates sales metrics grouped by offer ID.
     *
     * Parses voucher memos to extract offer IDs (format: "offer:<offerId>|...")
     * and aggregates sales data per offer.
     *
     * @param vouchers List of vouchers to analyze
     * @return Map of offer ID to OfferSales metrics
     */
    private fun calculateSalesByOffer(vouchers: List<cash.imani.voucher.domain.StoredVoucher>): Map<String, OfferSales> {
        // Extract offerId from memo (format: "offer:<offerId>|...")
        val vouchersByOffer =
            vouchers.mapNotNull { voucher ->
                val offerId = voucher.memo?.let { extractOfferId(it) }
                if (offerId != null) offerId to voucher else null
            }.groupBy({ it.first }, { it.second })

        // Aggregate metrics per offer
        return vouchersByOffer.mapValues { (_, vouchersForOffer) ->
            val issued = vouchersForOffer.size
            val redeemed = vouchersForOffer.count { it.status == VoucherStatus.REDEEMED }
            val revenue = vouchersForOffer.filter { it.status == VoucherStatus.REDEEMED }.sumOf { it.faceValue }

            OfferSales(
                vouchersIssued = issued,
                vouchersRedeemed = redeemed,
                revenue = revenue,
            )
        }
    }

    /**
     * Extracts offer ID from voucher memo.
     *
     * Expected format: "offer:<offerId>|<description>"
     * Example: "offer:coffee-special|$5 Coffee Deal"
     *
     * @param memo Voucher memo field
     * @return Offer ID if found, null otherwise
     */
    private fun extractOfferId(memo: String): String? {
        val prefix = "offer:"
        return if (memo.startsWith(prefix)) {
            // Extract offerId between "offer:" and "|" (or end of string)
            val startIndex = prefix.length
            val endIndex = memo.indexOf('|', startIndex).takeIf { it >= 0 } ?: memo.length
            memo.substring(startIndex, endIndex).takeIf { it.isNotBlank() }
        } else {
            null
        }
    }
}

/**
 * Exception thrown when sales metrics calculation fails.
 *
 * @param message Error description
 * @param cause Underlying cause (optional)
 */
class VoucherMetricsException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
