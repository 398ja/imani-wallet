package cash.imani.voucher.integration

import cash.imani.voucher.adapter.JvmVoucherAdapter
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
import kotlinx.datetime.Instant
import xyz.tcheeric.wallet.core.VoucherService
import xyz.tcheeric.wallet.core.state.StoredVoucher as JavaStoredVoucher
import xyz.tcheeric.wallet.core.VoucherService.IssueVoucherRequest as JavaIssueVoucherRequest
import xyz.tcheeric.wallet.core.VoucherService.IssueVoucherResult as JavaIssueVoucherResult
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Integration tests for voucher workflows.
 *
 * Tests the complete voucher lifecycle and integration points:
 * - Issue → Backup to Nostr → Restore from Nostr → Query by status
 * - List all vouchers
 * - Query vouchers by status (ISSUED, REDEEMED)
 * - Error handling and edge cases
 *
 * Uses JvmVoucherAdapter with mocked VoucherService to simulate cashu-client behavior
 * without requiring a real Cashu mint or Nostr relay.
 *
 * **Phase 2 Task 2.5.3**: Integration Tests (Full Voucher Flow)
 *
 * @see JvmVoucherAdapterTest for unit tests of individual methods
 */
@OptIn(ExperimentalCoroutinesApi::class)
class VoucherIntegrationTest {
    private lateinit var mockVoucherService: VoucherService
    private lateinit var adapter: JvmVoucherAdapter
    private val testDispatcher = StandardTestDispatcher()

    /**
     * Set up test environment before each test.
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

    // ==================== Full Flow Tests ====================

    /**
     * Tests the complete voucher lifecycle: issue → backup to Nostr → restore from Nostr.
     *
     * Verifies:
     * 1. Voucher can be issued successfully
     * 2. Voucher is automatically backed up to Nostr
     * 3. Voucher can be restored from Nostr
     * 4. Restored voucher has same data as issued voucher
     */
    @Test
    fun issueBackupRestoreFlowCompletesSuccessfully() =
        runTest {
            // Given: Issue request
            val request =
                IssueVoucherRequest(
                    amount = 5000L,
                    unit = "sat",
                    mintUrl = "https://mint.example.com",
                    expiresInDays = 30,
                    memo = "Integration test voucher",
                )

            // Mock issue response
            val issuedVoucher = createJavaVoucher(voucherId = "voucher-123", faceValue = 5000L, status = "issued")
            val issueResult =
                mockk<JavaIssueVoucherResult> {
                    every { voucher() } returns issuedVoucher
                    every { token() } returns "cashuABCDEF123456"
                    every { backedUp() } returns true
                    every { message() } returns "Voucher issued and backed up"
                }

            coEvery {
                mockVoucherService.issueAndBackup(
                    match<JavaIssueVoucherRequest> {
                        it.amount() == 5000L &&
                            it.unit() == "sat" &&
                            it.mintUrl() == "https://mint.example.com" &&
                            it.expiresInDays() == 30 &&
                            it.memo() == "Integration test voucher"
                    },
                )
            } returns issueResult

            // Mock restore response (VoucherService.restoreFromNostr returns int, then listVouchers is called)
            every { mockVoucherService.restoreFromNostr() } returns 1 // 1 voucher restored
            every { mockVoucherService.listVouchers() } returns listOf(issuedVoucher)

            // When: Issue voucher
            val issueResultKotlin = adapter.issueVoucher(request)

            // Then: Voucher issued successfully
            assertTrue(issueResultKotlin.isSuccess)
            val result = issueResultKotlin.getOrThrow()
            assertEquals("voucher-123", result.voucher.voucherId)
            assertEquals(5000L, result.voucher.faceValue)
            assertEquals(VoucherStatus.ISSUED, result.voucher.status)
            assertEquals("cashuABCDEF123456", result.token)
            assertTrue(result.backedUp)

            // When: Restore from Nostr
            val restoreResult = adapter.restoreFromNostr()

            // Then: Restore successful (returns list of vouchers)
            assertTrue(restoreResult.isSuccess)
            val restoredVouchers = restoreResult.getOrThrow()
            assertEquals(1, restoredVouchers.size)
            assertEquals("voucher-123", restoredVouchers[0].voucherId)

            // Verify interactions
            coVerify(exactly = 1) { mockVoucherService.issueAndBackup(any()) }
            coVerify(exactly = 1) { mockVoucherService.restoreFromNostr() }
            coVerify(exactly = 1) { mockVoucherService.listVouchers() }
        }

    /**
     * Tests listing all vouchers after issuing multiple vouchers.
     *
     * Verifies:
     * 1. Multiple vouchers can be issued
     * 2. listVouchers returns all issued vouchers
     * 3. Vouchers are returned in correct order
     */
    @Test
    fun listVouchersReturnsAllIssuedVouchers() =
        runTest {
            // Given: Three issued vouchers
            val voucher1 = createJavaVoucher(voucherId = "v1", faceValue = 1000L, status = "issued")
            val voucher2 = createJavaVoucher(voucherId = "v2", faceValue = 2000L, status = "redeemed")
            val voucher3 = createJavaVoucher(voucherId = "v3", faceValue = 3000L, status = "issued")

            every { mockVoucherService.listVouchers() } returns listOf(voucher1, voucher2, voucher3)

            // When: List vouchers
            val result = adapter.listVouchers()

            // Then: All vouchers returned
            assertTrue(result.isSuccess)
            val vouchers = result.getOrThrow()
            assertEquals(3, vouchers.size)
            assertEquals("v1", vouchers[0].voucherId)
            assertEquals("v2", vouchers[1].voucherId)
            assertEquals("v3", vouchers[2].voucherId)
            assertEquals(1000L, vouchers[0].faceValue)
            assertEquals(2000L, vouchers[1].faceValue)
            assertEquals(3000L, vouchers[2].faceValue)

            coVerify(exactly = 1) { mockVoucherService.listVouchers() }
        }

    /**
     * Tests querying vouchers by status.
     *
     * Verifies:
     * 1. Can query vouchers with ISSUED status
     * 2. Can query vouchers with REDEEMED status
     * 3. Returns only vouchers matching the requested status
     *
     * Note: queryVouchersByStatus is implemented in JvmVoucherAdapter by filtering listVouchers()
     */
    @Test
    fun queryVouchersByStatusFiltersCorrectly() =
        runTest {
            // Given: Vouchers with different statuses
            val issuedVoucher1 = createJavaVoucher(voucherId = "v1", status = "issued")
            val issuedVoucher2 = createJavaVoucher(voucherId = "v2", status = "issued")
            val redeemedVoucher = createJavaVoucher(voucherId = "v3", status = "redeemed")

            // Mock listVouchers (queryByStatus filters this list)
            every { mockVoucherService.listVouchers() } returns
                listOf(issuedVoucher1, issuedVoucher2, redeemedVoucher)

            // When: Query ISSUED vouchers
            val issuedResult = adapter.queryVouchersByStatus(VoucherStatus.ISSUED)

            // Then: Only ISSUED vouchers returned
            assertTrue(issuedResult.isSuccess)
            val issuedVouchers = issuedResult.getOrThrow()
            assertEquals(2, issuedVouchers.size)
            assertTrue(issuedVouchers.all { it.status == VoucherStatus.ISSUED })
            assertEquals("v1", issuedVouchers[0].voucherId)
            assertEquals("v2", issuedVouchers[1].voucherId)

            // When: Query REDEEMED vouchers
            val redeemedResult = adapter.queryVouchersByStatus(VoucherStatus.REDEEMED)

            // Then: Only REDEEMED vouchers returned
            assertTrue(redeemedResult.isSuccess)
            val redeemedVouchers = redeemedResult.getOrThrow()
            assertEquals(1, redeemedVouchers.size)
            assertEquals(VoucherStatus.REDEEMED, redeemedVouchers[0].status)
            assertEquals("v3", redeemedVouchers[0].voucherId)

            // queryVouchersByStatus calls listVouchers twice (once per query)
            coVerify(exactly = 2) { mockVoucherService.listVouchers() }
        }

    /**
     * Tests backup to Nostr after issuing multiple vouchers.
     *
     * Verifies:
     * 1. Multiple vouchers can be backed up
     * 2. Backup operation completes successfully
     */
    @Test
    fun backupToNostrAfterIssuingMultipleVouchers() =
        runTest {
            // Given: Two issued vouchers
            val voucher1 = createJavaVoucher(voucherId = "v1", faceValue = 1000L)
            val voucher2 = createJavaVoucher(voucherId = "v2", faceValue = 2000L)

            val issueResult1 =
                mockk<JavaIssueVoucherResult> {
                    every { voucher() } returns voucher1
                    every { token() } returns "token1"
                    every { backedUp() } returns true
                    every { message() } returns "Voucher 1 issued"
                }

            val issueResult2 =
                mockk<JavaIssueVoucherResult> {
                    every { voucher() } returns voucher2
                    every { token() } returns "token2"
                    every { backedUp() } returns true
                    every { message() } returns "Voucher 2 issued"
                }

            coEvery { mockVoucherService.issueAndBackup(match { it.amount() == 1000L }) } returns issueResult1
            coEvery { mockVoucherService.issueAndBackup(match { it.amount() == 2000L }) } returns issueResult2
            every { mockVoucherService.backupToNostr() } returns Unit

            // When: Issue two vouchers
            val result1 =
                adapter.issueVoucher(
                    IssueVoucherRequest(
                        amount = 1000L,
                        unit = "sat",
                        mintUrl = "https://mint.example.com",
                    ),
                )
            val result2 =
                adapter.issueVoucher(
                    IssueVoucherRequest(
                        amount = 2000L,
                        unit = "sat",
                        mintUrl = "https://mint.example.com",
                    ),
                )

            // Then: Both issued and backed up
            assertTrue(result1.isSuccess)
            assertTrue(result2.isSuccess)
            assertTrue(result1.getOrThrow().backedUp)
            assertTrue(result2.getOrThrow().backedUp)

            // When: Explicit backup to Nostr
            val backupResult = adapter.backupToNostr()

            // Then: Backup successful
            assertTrue(backupResult.isSuccess)

            coVerify(exactly = 2) { mockVoucherService.issueAndBackup(any()) }
            coVerify(exactly = 1) { mockVoucherService.backupToNostr() }
        }

    // ==================== Error Scenario Tests ====================

    /**
     * Tests handling of empty voucher list.
     *
     * Verifies:
     * 1. listVouchers handles empty list correctly
     * 2. Returns success with empty list (not failure)
     */
    @Test
    fun listVouchersReturnsEmptyListWhenNoVouchers() =
        runTest {
            // Given: Empty voucher list
            every { mockVoucherService.listVouchers() } returns emptyList()

            // When: List vouchers
            val result = adapter.listVouchers()

            // Then: Empty list returned successfully
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow().isEmpty())

            coVerify(exactly = 1) { mockVoucherService.listVouchers() }
        }

    /**
     * Tests querying by status when no vouchers match.
     *
     * Verifies:
     * 1. Returns empty list when no vouchers have requested status
     * 2. Doesn't throw exception for empty result
     */
    @Test
    fun queryVouchersByStatusReturnsEmptyListWhenNoMatches() =
        runTest {
            // Given: No vouchers with REVOKED status
            val issuedVoucher = createJavaVoucher(voucherId = "v1", status = "issued")
            every { mockVoucherService.listVouchers() } returns listOf(issuedVoucher)

            // When: Query REVOKED vouchers
            val result = adapter.queryVouchersByStatus(VoucherStatus.REVOKED)

            // Then: Empty list returned
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow().isEmpty())

            coVerify(exactly = 1) { mockVoucherService.listVouchers() }
        }

    /**
     * Tests restore from Nostr when no vouchers are found.
     *
     * Verifies:
     * 1. Returns empty list when no vouchers to restore
     * 2. Doesn't fail when Nostr is empty
     */
    @Test
    fun restoreFromNostrReturnsEmptyListWhenNoVouchersFound() =
        runTest {
            // Given: No vouchers in Nostr
            every { mockVoucherService.restoreFromNostr() } returns 0
            every { mockVoucherService.listVouchers() } returns emptyList()

            // When: Restore from Nostr
            val result = adapter.restoreFromNostr()

            // Then: Returns empty list successfully
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow().isEmpty())

            coVerify(exactly = 1) { mockVoucherService.restoreFromNostr() }
            coVerify(exactly = 1) { mockVoucherService.listVouchers() }
        }

    // ==================== Test Helpers ====================

    /**
     * Creates a mock Java StoredVoucher for testing.
     */
    private fun createJavaVoucher(
        voucherId: String = "voucher-1",
        issuerId: String = "issuer-npub123",
        unit: String = "sat",
        faceValue: Long = 1000L,
        expiresAt: Long? = null,
        memo: String? = "Test voucher",
        issuerSignature: String = "signature-hex",
        issuerPublicKey: String = "0".repeat(64),
        issuedAt: Instant = Clock.System.now(),
        status: String = "issued",
    ): JavaStoredVoucher =
        mockk<JavaStoredVoucher> {
            every { voucherId() } returns voucherId
            every { issuerId() } returns issuerId
            every { unit() } returns unit
            every { faceValue() } returns faceValue
            every { expiresAt() } returns expiresAt
            every { memo() } returns memo
            every { issuerSignature() } returns issuerSignature
            every { issuerPublicKey() } returns issuerPublicKey
            // Convert Kotlin Instant to Java Instant
            every { issuedAt() } returns java.time.Instant.ofEpochSecond(issuedAt.epochSeconds, issuedAt.nanosecondsOfSecond.toLong())
            every { status() } returns status
        }
}

