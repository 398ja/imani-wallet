package cash.imani.voucher.usecases

import cash.imani.voucher.domain.SalesMetrics
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.repository.VoucherRepository
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

/**
 * Unit tests for GetSalesMetricsUseCase.
 *
 * Tests metric calculation, period filtering, offer grouping, and edge cases.
 */
class GetSalesMetricsUseCaseTest {
    private val now = Clock.System.now()
    private val periodStart = now.minus(30.days)
    private val periodEnd = now

    /**
     * Tests that metrics are correctly calculated for a simple scenario
     * with issued and redeemed vouchers within the period.
     */
    @Test
    fun `should calculate basic metrics for vouchers in period`() =
        runTest {
            // Given: Repository with 5 issued vouchers, 3 redeemed
            val vouchers =
                listOf(
                    createVoucher("v1", 1000, VoucherStatus.ISSUED, now.minus(10.days)),
                    createVoucher("v2", 2000, VoucherStatus.REDEEMED, now.minus(9.days)),
                    createVoucher("v3", 3000, VoucherStatus.REDEEMED, now.minus(8.days)),
                    createVoucher("v4", 4000, VoucherStatus.REDEEMED, now.minus(7.days)),
                    createVoucher("v5", 5000, VoucherStatus.ISSUED, now.minus(6.days)),
                )
            val repository = FakeVoucherRepository(vouchers)
            val useCase = GetSalesMetricsUseCase(repository)

            // When: Getting metrics for the period
            val result = useCase(periodStart, periodEnd)

            // Then: Metrics should reflect the correct counts and revenue
            assertTrue(result.isSuccess)
            val metrics = result.getOrThrow()
            assertEquals(5, metrics.totalVouchersIssued)
            assertEquals(3, metrics.totalVouchersRedeemed)
            assertEquals(9000, metrics.totalRevenue) // 2000 + 3000 + 4000
            assertEquals(0.6, metrics.redemptionRate) // 3/5 = 0.6
        }

    /**
     * Tests that vouchers outside the period are excluded from metrics.
     */
    @Test
    fun `should exclude vouchers outside period`() =
        runTest {
            // Given: Vouchers both inside and outside the period
            val vouchers =
                listOf(
                    createVoucher("v1", 1000, VoucherStatus.REDEEMED, periodStart.minus(1.days)), // Before period
                    createVoucher("v2", 2000, VoucherStatus.REDEEMED, periodStart), // Start of period
                    createVoucher("v3", 3000, VoucherStatus.REDEEMED, periodEnd), // End of period
                    createVoucher("v4", 4000, VoucherStatus.REDEEMED, periodEnd.plus(1.days)), // After period
                )
            val repository = FakeVoucherRepository(vouchers)
            val useCase = GetSalesMetricsUseCase(repository)

            // When: Getting metrics for the period
            val result = useCase(periodStart, periodEnd)

            // Then: Only vouchers within period should be counted
            assertTrue(result.isSuccess)
            val metrics = result.getOrThrow()
            assertEquals(2, metrics.totalVouchersIssued) // v2, v3
            assertEquals(2, metrics.totalVouchersRedeemed)
            assertEquals(5000, metrics.totalRevenue) // 2000 + 3000
        }

    /**
     * Tests handling of empty voucher list (no sales in period).
     */
    @Test
    fun `should return zero metrics when no vouchers in period`() =
        runTest {
            // Given: Empty repository
            val repository = FakeVoucherRepository(emptyList())
            val useCase = GetSalesMetricsUseCase(repository)

            // When: Getting metrics for the period
            val result = useCase(periodStart, periodEnd)

            // Then: Metrics should be zero
            assertTrue(result.isSuccess)
            val metrics = result.getOrThrow()
            assertEquals(0, metrics.totalVouchersIssued)
            assertEquals(0, metrics.totalVouchersRedeemed)
            assertEquals(0, metrics.totalRevenue)
            assertEquals(0.0, metrics.redemptionRate)
        }

    /**
     * Tests calculation of redemption rate with different scenarios.
     */
    @Test
    fun `should calculate correct redemption rate`() =
        runTest {
            // Given: 10 issued, 7 redeemed
            val vouchers =
                (1..10).map { i ->
                    val status = if (i <= 7) VoucherStatus.REDEEMED else VoucherStatus.ISSUED
                    createVoucher("v$i", 1000, status, now.minus(i.days))
                }
            val repository = FakeVoucherRepository(vouchers)
            val useCase = GetSalesMetricsUseCase(repository)

            // When: Getting metrics
            val result = useCase(periodStart, periodEnd)

            // Then: Redemption rate should be 0.7 (7/10)
            assertTrue(result.isSuccess)
            val metrics = result.getOrThrow()
            assertEquals(0.7, metrics.redemptionRate)
        }

    /**
     * Tests grouping of sales by offer ID extracted from voucher memos.
     */
    @Test
    fun `should group sales by offer ID from memo`() =
        runTest {
            // Given: Vouchers with offer IDs in memo
            val vouchers =
                listOf(
                    createVoucher("v1", 1000, VoucherStatus.REDEEMED, now.minus(5.days), "offer:coffee|Coffee Deal"),
                    createVoucher("v2", 2000, VoucherStatus.REDEEMED, now.minus(4.days), "offer:coffee|Coffee Deal"),
                    createVoucher("v3", 3000, VoucherStatus.ISSUED, now.minus(3.days), "offer:coffee|Coffee Deal"),
                    createVoucher("v4", 4000, VoucherStatus.REDEEMED, now.minus(2.days), "offer:tea|Tea Special"),
                    createVoucher("v5", 5000, VoucherStatus.ISSUED, now.minus(1.days), "No offer"),
                )
            val repository = FakeVoucherRepository(vouchers)
            val useCase = GetSalesMetricsUseCase(repository)

            // When: Getting metrics
            val result = useCase(periodStart, periodEnd)

            // Then: Sales should be grouped by offer
            assertTrue(result.isSuccess)
            val metrics = result.getOrThrow()
            assertEquals(2, metrics.salesByOffer.size)

            val coffeeSales = metrics.salesByOffer["coffee"]!!
            assertEquals(3, coffeeSales.vouchersIssued)
            assertEquals(2, coffeeSales.vouchersRedeemed)
            assertEquals(3000, coffeeSales.revenue) // 1000 + 2000

            val teaSales = metrics.salesByOffer["tea"]!!
            assertEquals(1, teaSales.vouchersIssued)
            assertEquals(1, teaSales.vouchersRedeemed)
            assertEquals(4000, teaSales.revenue)
        }

    /**
     * Tests validation of period start/end order.
     */
    @Test
    fun `should fail when period start is after period end`() =
        runTest {
            // Given: Invalid period (start > end)
            val repository = FakeVoucherRepository(emptyList())
            val useCase = GetSalesMetricsUseCase(repository)

            // When: Getting metrics with invalid period
            val result = useCase(periodEnd, periodStart) // Swapped order

            // Then: Should fail with IllegalArgumentException
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests helper methods on SalesMetrics.
     */
    @Test
    fun `should calculate average voucher value correctly`() =
        runTest {
            // Given: Vouchers with known values
            val vouchers =
                listOf(
                    createVoucher("v1", 1000, VoucherStatus.REDEEMED, now.minus(5.days)),
                    createVoucher("v2", 3000, VoucherStatus.REDEEMED, now.minus(4.days)),
                    createVoucher("v3", 5000, VoucherStatus.REDEEMED, now.minus(3.days)),
                )
            val repository = FakeVoucherRepository(vouchers)
            val useCase = GetSalesMetricsUseCase(repository)

            // When: Getting metrics
            val result = useCase(periodStart, periodEnd)

            // Then: Average should be 3000 (9000 / 3)
            assertTrue(result.isSuccess)
            val metrics = result.getOrThrow()
            assertEquals(3000, metrics.averageVoucherValue())
        }

    // ==================== Test Helpers ====================

    /**
     * Creates a test voucher with specified parameters.
     */
    private fun createVoucher(
        id: String,
        amount: Long,
        status: VoucherStatus,
        issuedAt: Instant,
        memo: String? = null,
    ): StoredVoucher =
        StoredVoucher(
            voucherId = id,
            issuerId = "test-merchant",
            unit = "sat",
            faceValue = amount,
            expiresAt = null,
            memo = memo,
            issuerSignature = "test-signature",
            issuerPublicKey = "0".repeat(64),
            issuedAt = issuedAt,
            status = status,
            token = null,
            deliveryMetadata = null,
            redemptionMetadata = null,
        )

    /**
     * Fake VoucherRepository for testing.
     */
    private class FakeVoucherRepository(
        private val vouchers: List<StoredVoucher>,
    ) : VoucherRepository {
        override suspend fun saveVoucher(voucher: StoredVoucher): Result<Unit> = Result.success(Unit)

        override suspend fun getVoucher(voucherId: String): Result<StoredVoucher?> =
            Result.success(vouchers.firstOrNull { it.voucherId == voucherId })

        override suspend fun getVouchersByIssuer(issuerId: String): Result<List<StoredVoucher>> =
            Result.success(vouchers.filter { it.issuerId == issuerId })

        override suspend fun getAllVouchers(): Result<List<StoredVoucher>> = Result.success(vouchers)

        override suspend fun updateVoucherStatus(
            voucherId: String,
            status: VoucherStatus,
        ): Result<Unit> = Result.success(Unit)

        override suspend fun deleteVoucher(voucherId: String): Result<Unit> = Result.success(Unit)

        override suspend fun getVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
            Result.success(vouchers.filter { it.status == status })
    }
}
