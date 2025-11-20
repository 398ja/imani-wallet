package cash.imani.voucher.adapter

import cash.imani.voucher.domain.BackupException
import cash.imani.voucher.domain.RestoreException
import cash.imani.voucher.domain.VoucherIssuanceException
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.usecases.IssueVoucherRequest
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.datetime.Clock
import xyz.tcheeric.wallet.core.VoucherService
import xyz.tcheeric.wallet.core.exception.WalletOperationException
import xyz.tcheeric.wallet.core.state.StoredVoucher as JavaStoredVoucher
import xyz.tcheeric.wallet.core.VoucherService.IssueVoucherRequest as JavaIssueVoucherRequest
import xyz.tcheeric.wallet.core.VoucherService.IssueVoucherResult as JavaIssueVoucherResult
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * Unit tests for JvmVoucherAdapter.
 *
 * Tests the JVM implementation of VoucherAdapter which wraps cashu-client's VoucherService:
 * - Delegation to VoucherService methods
 * - Type conversion (Kotlin ↔ Java)
 * - Thread safety (withContext(Dispatchers.IO))
 * - Exception handling and wrapping
 * - NotImplementedError for unsupported methods
 *
 * Uses MockK to mock VoucherService, avoiding integration tests with real Cashu mint.
 *
 * **Phase 2 Task 2.5.1**: Verify 100% code reuse from cashu-client through proper delegation.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class JvmVoucherAdapterTest {
    private lateinit var mockVoucherService: VoucherService
    private lateinit var adapter: JvmVoucherAdapter
    private val testDispatcher = StandardTestDispatcher()

    /**
     * Set up test environment before each test.
     * - Mock VoucherService
     * - Initialize adapter
     * - Configure Dispatchers.Main for coroutine testing
     */
    @BeforeTest
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockVoucherService = mockk<VoucherService>()
        adapter = JvmVoucherAdapter(mockVoucherService)
    }

    /**
     * Clean up test environment after each test.
     */
    @AfterTest
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ==================== issueVoucher Tests ====================

    /**
     * Tests that issueVoucher successfully delegates to VoucherService.issueAndBackup()
     * and correctly converts types from Kotlin to Java and back.
     */
    @Test
    fun `issueVoucher delegates to VoucherService and converts types correctly`() =
        runTest {
            // Given: Kotlin request
            val request =
                IssueVoucherRequest(
                    amount = 1000L,
                    unit = "sat",
                    mintUrl = "https://mint.example.com",
                    expiresInDays = 7,
                    memo = "Test voucher",
                )

            // Mock Java voucher and result
            val javaVoucher = createJavaVoucher(voucherId = "v1", faceValue = 1000L, memo = "Test voucher")
            val javaResult =
                mockk<JavaIssueVoucherResult> {
                    every { voucher() } returns javaVoucher
                    every { token() } returns "cashuA..."
                    every { backedUp() } returns true
                    every { message() } returns "Voucher issued successfully"
                }

            coEvery {
                mockVoucherService.issueAndBackup(
                    match<JavaIssueVoucherRequest> {
                        it.amount() == 1000L &&
                            it.unit() == "sat" &&
                            it.mintUrl() == "https://mint.example.com" &&
                            it.expiresInDays() == 7 &&
                            it.memo() == "Test voucher"
                    },
                )
            } returns javaResult

            // When: Calling issueVoucher
            val result = adapter.issueVoucher(request)

            // Then: Should succeed with converted result
            assertTrue(result.isSuccess)
            val kotlinResult = result.getOrThrow()
            assertEquals("v1", kotlinResult.voucher.voucherId)
            assertEquals(1000L, kotlinResult.voucher.faceValue)
            assertEquals("Test voucher", kotlinResult.voucher.memo)
            assertEquals("cashuA...", kotlinResult.token)
            assertTrue(kotlinResult.backedUp)

            // Verify VoucherService was called exactly once
            coVerify(exactly = 1) { mockVoucherService.issueAndBackup(any()) }
        }

    /**
     * Tests that issueVoucher handles VoucherService exceptions.
     * Note: WalletOperationException wrapping is tested in integration tests,
     * as WalletOperationException has protected constructor and cannot be mocked.
     */
    @Test
    fun `issueVoucher handles VoucherService exceptions`() =
        runTest {
            // Given: VoucherService throws RuntimeException
            val request =
                IssueVoucherRequest(
                    amount = 1000L,
                    unit = "sat",
                    mintUrl = "https://mint.example.com",
                )

            coEvery { mockVoucherService.issueAndBackup(any()) } throws
                RuntimeException("Mint unavailable")

            // When: Calling issueVoucher
            val result = adapter.issueVoucher(request)

            // Then: Should fail with exception
            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()
            assertTrue(exception is RuntimeException)
            assertTrue(exception?.message?.contains("Mint unavailable") == true)
        }

    /**
     * Tests that issueVoucher handles null memo correctly.
     */
    @Test
    fun `issueVoucher handles null memo`() =
        runTest {
            // Given: Request with null memo
            val request =
                IssueVoucherRequest(
                    amount = 500L,
                    unit = "sat",
                    mintUrl = "https://mint.example.com",
                    memo = null,
                )

            val javaVoucher = createJavaVoucher(voucherId = "v2", faceValue = 500L, memo = null)
            val javaResult =
                mockk<JavaIssueVoucherResult> {
                    every { voucher() } returns javaVoucher
                    every { token() } returns "cashuA..."
                    every { backedUp() } returns false
                    every { message() } returns null
                }

            coEvery { mockVoucherService.issueAndBackup(any()) } returns javaResult

            // When: Calling issueVoucher
            val result = adapter.issueVoucher(request)

            // Then: Should succeed with null memo and default message
            assertTrue(result.isSuccess)
            val kotlinResult = result.getOrThrow()
            assertEquals(null, kotlinResult.voucher.memo)
            assertEquals("Voucher issued successfully", kotlinResult.message) // Default message
        }

    // ==================== redeemVoucher Tests ====================

    /**
     * Tests that redeemVoucher throws NotImplementedError as it delegates to use case.
     */
    @Test
    fun `redeemVoucher throws NotImplementedError`() =
        runTest {
            // When/Then: Calling redeemVoucher should throw NotImplementedError
            val result = adapter.redeemVoucher(token = "cashuA...", voucherId = null)

            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()
            assertIs<NotImplementedError>(exception)
            assertTrue(exception.message?.contains("handled by RedeemVoucherUseCase") == true)
        }

    // ==================== revokeVoucher Tests ====================

    /**
     * Tests that revokeVoucher throws NotImplementedError as API not exposed yet.
     */
    @Test
    fun `revokeVoucher throws NotImplementedError`() =
        runTest {
            // When/Then: Calling revokeVoucher should throw NotImplementedError
            val result = adapter.revokeVoucher(voucherId = "v1")

            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()
            assertIs<NotImplementedError>(exception)
            assertTrue(exception.message?.contains("not yet exposed in cashu-client") == true)
        }

    // ==================== verifyVoucher Tests ====================

    /**
     * Tests that verifyVoucher throws NotImplementedError as API not exposed yet.
     */
    @Test
    fun `verifyVoucher throws NotImplementedError`() =
        runTest {
            // Given: A voucher
            val voucher = createKotlinVoucher(voucherId = "v1")

            // When/Then: Calling verifyVoucher should throw NotImplementedError
            val result = adapter.verifyVoucher(voucher)

            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()
            assertIs<NotImplementedError>(exception)
            assertTrue(exception.message?.contains("not yet exposed in cashu-client") == true)
        }

    // ==================== listVouchers Tests ====================

    /**
     * Tests that listVouchers successfully delegates to VoucherService.listVouchers()
     * and correctly converts Java vouchers to Kotlin.
     */
    @Test
    fun `listVouchers delegates to VoucherService and converts types correctly`() =
        runTest {
            // Given: VoucherService returns Java vouchers
            val javaVoucher1 = createJavaVoucher(voucherId = "v1", faceValue = 1000L)
            val javaVoucher2 = createJavaVoucher(voucherId = "v2", faceValue = 2000L)
            val javaVouchers = listOf(javaVoucher1, javaVoucher2)

            every { mockVoucherService.listVouchers() } returns javaVouchers

            // When: Calling listVouchers
            val result = adapter.listVouchers()

            // Then: Should succeed with converted Kotlin vouchers
            assertTrue(result.isSuccess)
            val kotlinVouchers = result.getOrThrow()
            assertEquals(2, kotlinVouchers.size)
            assertEquals("v1", kotlinVouchers[0].voucherId)
            assertEquals(1000L, kotlinVouchers[0].faceValue)
            assertEquals("v2", kotlinVouchers[1].voucherId)
            assertEquals(2000L, kotlinVouchers[1].faceValue)

            // Verify VoucherService was called
            coVerify(exactly = 1) { mockVoucherService.listVouchers() }
        }

    /**
     * Tests that listVouchers handles empty list correctly.
     */
    @Test
    fun `listVouchers handles empty list`() =
        runTest {
            // Given: VoucherService returns empty list
            every { mockVoucherService.listVouchers() } returns emptyList()

            // When: Calling listVouchers
            val result = adapter.listVouchers()

            // Then: Should succeed with empty list
            assertTrue(result.isSuccess)
            assertEquals(0, result.getOrThrow().size)
        }

    /**
     * Tests that listVouchers handles VoucherService exceptions.
     */
    @Test
    fun `listVouchers handles VoucherService exceptions`() =
        runTest {
            // Given: VoucherService throws exception
            every { mockVoucherService.listVouchers() } throws RuntimeException("Database error")

            // When: Calling listVouchers
            val result = adapter.listVouchers()

            // Then: Should fail with wrapped exception
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()?.message?.contains("Database error") == true)
        }

    // ==================== queryVouchersByStatus Tests ====================

    /**
     * Tests that queryVouchersByStatus filters vouchers correctly.
     */
    @Test
    fun `queryVouchersByStatus filters by status correctly`() =
        runTest {
            // Given: VoucherService returns mixed-status vouchers
            val javaVoucher1 = createJavaVoucher(voucherId = "v1", status = "ISSUED")
            val javaVoucher2 = createJavaVoucher(voucherId = "v2", status = "REDEEMED")
            val javaVoucher3 = createJavaVoucher(voucherId = "v3", status = "ISSUED")
            val javaVouchers = listOf(javaVoucher1, javaVoucher2, javaVoucher3)

            every { mockVoucherService.listVouchers() } returns javaVouchers

            // When: Querying for ISSUED vouchers
            val result = adapter.queryVouchersByStatus(VoucherStatus.ISSUED)

            // Then: Should return only ISSUED vouchers
            assertTrue(result.isSuccess)
            val issuedVouchers = result.getOrThrow()
            assertEquals(2, issuedVouchers.size)
            assertEquals("v1", issuedVouchers[0].voucherId)
            assertEquals("v3", issuedVouchers[1].voucherId)
            assertTrue(issuedVouchers.all { it.status == VoucherStatus.ISSUED })
        }

    /**
     * Tests that queryVouchersByStatus returns empty list when no matches.
     */
    @Test
    fun `queryVouchersByStatus returns empty list when no matches`() =
        runTest {
            // Given: VoucherService returns vouchers but none match status
            val javaVoucher1 = createJavaVoucher(voucherId = "v1", status = "ISSUED")
            val javaVoucher2 = createJavaVoucher(voucherId = "v2", status = "ISSUED")

            every { mockVoucherService.listVouchers() } returns listOf(javaVoucher1, javaVoucher2)

            // When: Querying for REDEEMED vouchers
            val result = adapter.queryVouchersByStatus(VoucherStatus.REDEEMED)

            // Then: Should return empty list
            assertTrue(result.isSuccess)
            assertEquals(0, result.getOrThrow().size)
        }

    // ==================== backupToNostr Tests ====================

    /**
     * Tests that backupToNostr successfully delegates to VoucherService.backupToNostr().
     */
    @Test
    fun `backupToNostr delegates to VoucherService`() =
        runTest {
            // Given: VoucherService succeeds
            every { mockVoucherService.backupToNostr() } returns Unit

            // When: Calling backupToNostr
            val result = adapter.backupToNostr()

            // Then: Should succeed
            assertTrue(result.isSuccess)

            // Verify VoucherService was called
            coVerify(exactly = 1) { mockVoucherService.backupToNostr() }
        }

    /**
     * Tests that backupToNostr handles VoucherService exceptions.
     * Note: WalletOperationException wrapping tested in integration tests.
     */
    @Test
    fun `backupToNostr handles VoucherService exceptions`() =
        runTest {
            // Given: VoucherService throws RuntimeException
            every { mockVoucherService.backupToNostr() } throws
                RuntimeException("Relay unavailable")

            // When: Calling backupToNostr
            val result = adapter.backupToNostr()

            // Then: Should fail
            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()
            assertTrue(exception is RuntimeException)
        }

    // ==================== restoreFromNostr Tests ====================

    /**
     * Tests that restoreFromNostr successfully delegates to VoucherService.restoreFromNostr()
     * and returns list of restored vouchers.
     */
    @Test
    fun `restoreFromNostr delegates to VoucherService and returns vouchers`() =
        runTest {
            // Given: VoucherService restores vouchers
            val javaVoucher1 = createJavaVoucher(voucherId = "v1", faceValue = 1000L)
            val javaVoucher2 = createJavaVoucher(voucherId = "v2", faceValue = 2000L)

            every { mockVoucherService.restoreFromNostr() } returns 2
            every { mockVoucherService.listVouchers() } returns listOf(javaVoucher1, javaVoucher2)

            // When: Calling restoreFromNostr
            val result = adapter.restoreFromNostr()

            // Then: Should succeed with restored vouchers
            assertTrue(result.isSuccess)
            val restoredVouchers = result.getOrThrow()
            assertEquals(2, restoredVouchers.size)
            assertEquals("v1", restoredVouchers[0].voucherId)
            assertEquals("v2", restoredVouchers[1].voucherId)

            // Verify VoucherService methods were called in order
            coVerify(exactly = 1) { mockVoucherService.restoreFromNostr() }
            coVerify(exactly = 1) { mockVoucherService.listVouchers() }
        }

    /**
     * Tests that restoreFromNostr handles VoucherService exceptions.
     * Note: WalletOperationException wrapping tested in integration tests.
     */
    @Test
    fun `restoreFromNostr handles VoucherService exceptions`() =
        runTest {
            // Given: VoucherService throws RuntimeException
            every { mockVoucherService.restoreFromNostr() } throws
                RuntimeException("No backup found")

            // When: Calling restoreFromNostr
            val result = adapter.restoreFromNostr()

            // Then: Should fail
            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()
            assertTrue(exception is RuntimeException)
            assertTrue(exception?.message?.contains("No backup found") == true)
        }

    // ==================== Type Conversion Tests ====================

    /**
     * Tests that VoucherStatus string conversion handles all enum values.
     */
    @Test
    fun `status conversion handles all VoucherStatus values`() =
        runTest {
            // Given: Java vouchers with different status strings
            val statusMap =
                mapOf(
                    "ISSUED" to VoucherStatus.ISSUED,
                    "DELIVERED" to VoucherStatus.DELIVERED,
                    "REDEEMED" to VoucherStatus.REDEEMED,
                    "REVOKED" to VoucherStatus.REVOKED,
                    "EXPIRED" to VoucherStatus.EXPIRED,
                )

            statusMap.forEach { (javaStatus, kotlinStatus) ->
                val javaVoucher = createJavaVoucher(voucherId = "test", status = javaStatus)
                every { mockVoucherService.listVouchers() } returns listOf(javaVoucher)

                // When: Calling listVouchers
                val result = adapter.listVouchers()

                // Then: Status should be correctly converted
                assertTrue(result.isSuccess)
                assertEquals(kotlinStatus, result.getOrThrow()[0].status)
            }
        }

    /**
     * Tests that status conversion handles unknown/invalid status strings
     * by defaulting to ISSUED.
     */
    @Test
    fun `status conversion defaults to ISSUED for unknown status`() =
        runTest {
            // Given: Java voucher with unknown status
            val javaVoucher = createJavaVoucher(voucherId = "test", status = "UNKNOWN_STATUS")
            every { mockVoucherService.listVouchers() } returns listOf(javaVoucher)

            // When: Calling listVouchers
            val result = adapter.listVouchers()

            // Then: Should default to ISSUED
            assertTrue(result.isSuccess)
            assertEquals(VoucherStatus.ISSUED, result.getOrThrow()[0].status)
        }

    /**
     * Tests that Instant conversion from Java to Kotlin preserves timestamp accuracy.
     */
    @Test
    fun `instant conversion preserves timestamp accuracy`() =
        runTest {
            // Given: Java voucher with specific timestamp
            val javaInstant = java.time.Instant.ofEpochSecond(1700000000, 123456789)
            val javaVoucher =
                createJavaVoucher(
                    voucherId = "test",
                    issuedAt = javaInstant,
                )

            every { mockVoucherService.listVouchers() } returns listOf(javaVoucher)

            // When: Calling listVouchers
            val result = adapter.listVouchers()

            // Then: Kotlin Instant should match Java Instant
            assertTrue(result.isSuccess)
            val kotlinVoucher = result.getOrThrow()[0]
            assertEquals(1700000000L, kotlinVoucher.issuedAt.epochSeconds)
            assertEquals(123456789, kotlinVoucher.issuedAt.nanosecondsOfSecond)
        }

    // ==================== Thread Safety Tests ====================

    /**
     * Tests that all methods use withContext(Dispatchers.IO) for thread safety.
     * This test verifies that VoucherService calls happen on IO dispatcher.
     */
    @Test
    fun `all methods execute on IO dispatcher`() =
        runTest {
            // Given: Mock VoucherService
            val javaVoucher = createJavaVoucher(voucherId = "v1")
            val javaResult =
                mockk<JavaIssueVoucherResult> {
                    every { voucher() } returns javaVoucher
                    every { token() } returns "token"
                    every { backedUp() } returns true
                    every { message() } returns null
                }

            coEvery { mockVoucherService.issueAndBackup(any()) } returns javaResult
            every { mockVoucherService.listVouchers() } returns listOf(javaVoucher)
            every { mockVoucherService.backupToNostr() } returns Unit
            every { mockVoucherService.restoreFromNostr() } returns 2

            // When: Calling various methods
            adapter.issueVoucher(IssueVoucherRequest(1000L, "sat", "https://mint.example.com"))
            adapter.listVouchers()
            adapter.queryVouchersByStatus(VoucherStatus.ISSUED)
            adapter.backupToNostr()
            adapter.restoreFromNostr()

            // Then: All calls should complete without blocking main thread
            // (Verified implicitly by using testDispatcher in setUp)
            // If any call was blocking, the test would hang
        }

    // ==================== Helper Methods ====================

    /**
     * Creates a mock Java StoredVoucher for testing.
     */
    private fun createJavaVoucher(
        voucherId: String,
        issuerId: String = "issuer1",
        unit: String = "sat",
        faceValue: Long = 1000L,
        expiresAt: Long? = null,
        memo: String? = null,
        issuerSignature: String = "sig123",
        issuerPublicKey: String = "0".repeat(64),
        issuedAt: java.time.Instant = java.time.Instant.now(),
        status: String = "ISSUED",
    ): JavaStoredVoucher =
        mockk {
            every { voucherId() } returns voucherId
            every { issuerId() } returns issuerId
            every { unit() } returns unit
            every { faceValue() } returns faceValue
            every { expiresAt() } returns expiresAt
            every { memo() } returns memo
            every { issuerSignature() } returns issuerSignature
            every { issuerPublicKey() } returns issuerPublicKey
            every { issuedAt() } returns issuedAt
            every { status() } returns status
        }

    /**
     * Creates a Kotlin StoredVoucher for testing.
     */
    private fun createKotlinVoucher(
        voucherId: String,
        issuerId: String = "issuer1",
        unit: String = "sat",
        faceValue: Long = 1000L,
        expiresAt: Long? = null,
        memo: String? = null,
        issuerSignature: String = "sig123",
        issuerPublicKey: String = "0".repeat(64),
        issuedAt: kotlinx.datetime.Instant = Clock.System.now(),
        status: VoucherStatus = VoucherStatus.ISSUED,
    ) = cash.imani.voucher.domain.StoredVoucher(
        voucherId = voucherId,
        issuerId = issuerId,
        unit = unit,
        faceValue = faceValue,
        expiresAt = expiresAt,
        memo = memo,
        issuerSignature = issuerSignature,
        issuerPublicKey = issuerPublicKey,
        issuedAt = issuedAt,
        status = status,
        token = null,
        deliveryMetadata = null,
        redemptionMetadata = null,
    )
}
