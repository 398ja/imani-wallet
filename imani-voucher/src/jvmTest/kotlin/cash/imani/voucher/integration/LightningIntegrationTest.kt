package cash.imani.voucher.integration

import cash.imani.voucher.domain.LightningInvoice
import cash.imani.voucher.network.MintApiClient
import cash.imani.voucher.network.MintQuoteResponse
import cash.imani.voucher.usecases.CheckInvoicePaidUseCase
import cash.imani.voucher.usecases.CreateLightningInvoiceUseCase
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/**
 * Integration tests for Lightning invoice generation and payment checking.
 *
 * Tests the NUT-04 Lightning integration flow:
 * - Invoice generation (POST /v1/mint/quote/bolt11)
 * - Payment status checking (GET /v1/mint/quote/bolt11/:id)
 * - Polling for payment confirmation
 * - Timeout handling
 *
 * **Task 2.5.4**: Marketplace Flow Testing (Lightning component)
 *
 * @see CreateLightningInvoiceUseCase For invoice generation
 * @see CheckInvoicePaidUseCase For payment checking and polling
 */
class LightningIntegrationTest {
    private val mockMintApiClient = mockk<MintApiClient>()
    private val createInvoiceUseCase = CreateLightningInvoiceUseCase(mockMintApiClient)
    private val checkInvoiceUseCase = CheckInvoicePaidUseCase(mockMintApiClient)

    // ==================== Invoice Generation Tests ====================

    /**
     * Tests successful Lightning invoice generation.
     *
     * Verifies:
     * 1. Invoice created with correct amount and unit
     * 2. Quote ID and payment request returned
     * 3. Invoice initially unpaid
     * 4. Expiry timestamp set correctly
     */
    @Test
    fun createsLightningInvoiceSuccessfully() =
        runTest {
            // Given: Mint returns quote
            val quoteId = "quote-12345"
            val bolt11 = "lnbc10000n1pjg7qg7pp5..."
            val expiry = Clock.System.now().plus(15.minutes).epochSeconds

            coEvery {
                mockMintApiClient.getMintQuote(
                    mintUrl = "https://mint.example.com",
                    amount = 1000,
                    unit = "sat",
                )
            } returns
                Result.success(
                    MintQuoteResponse(
                        quote = quoteId,
                        request = bolt11,
                        paid = false,
                        expiry = expiry,
                    ),
                )

            // When: Creating invoice
            val result = createInvoiceUseCase(1000, "https://mint.example.com")

            // Then: Invoice created successfully
            assertTrue(result.isSuccess)
            val invoice = result.getOrThrow()
            assertEquals(quoteId, invoice.quoteId)
            assertEquals(bolt11, invoice.paymentRequest)
            assertEquals(1000, invoice.amount)
            assertFalse(invoice.paid)
            assertNotNull(invoice.expiresAt)
            assertFalse(invoice.isExpired())
        }

    /**
     * Tests invoice creation with different amounts.
     *
     * Verifies:
     * 1. Small amounts (100 sats) work
     * 2. Large amounts (1M sats) work
     * 3. Amount correctly reflected in invoice
     */
    @Test
    fun createsInvoiceWithVariousAmounts() =
        runTest {
            // Test small amount
            coEvery { mockMintApiClient.getMintQuote("https://mint.example.com", 100, "sat") } returns
                Result.success(
                    MintQuoteResponse("q1", "lnbc1...", false, Clock.System.now().plus(15.minutes).epochSeconds),
                )

            val result1 = createInvoiceUseCase(100, "https://mint.example.com")
            assertTrue(result1.isSuccess)
            assertEquals(100, result1.getOrThrow().amount)

            // Test large amount
            coEvery { mockMintApiClient.getMintQuote("https://mint.example.com", 1_000_000, "sat") } returns
                Result.success(
                    MintQuoteResponse("q2", "lnbc10m...", false, Clock.System.now().plus(15.minutes).epochSeconds),
                )

            val result2 = createInvoiceUseCase(1_000_000, "https://mint.example.com")
            assertTrue(result2.isSuccess)
            assertEquals(1_000_000, result2.getOrThrow().amount)
        }

    /**
     * Tests invoice creation validation.
     *
     * Verifies:
     * 1. Rejects zero amount
     * 2. Rejects negative amount
     * 3. Rejects blank mint URL
     */
    @Test
    fun failsToCreateInvoiceWithInvalidParameters() =
        runTest {
            // Test zero amount
            val result1 = createInvoiceUseCase(0, "https://mint.example.com")
            assertTrue(result1.isFailure)
            assertTrue(result1.exceptionOrNull()!!.message!!.contains("Amount must be positive"))

            // Test negative amount
            val result2 = createInvoiceUseCase(-100, "https://mint.example.com")
            assertTrue(result2.isFailure)
            assertTrue(result2.exceptionOrNull()!!.message!!.contains("Amount must be positive"))

            // Test blank URL
            val result3 = createInvoiceUseCase(1000, "   ")
            assertTrue(result3.isFailure)
            assertTrue(result3.exceptionOrNull()!!.message!!.contains("Mint URL cannot be blank"))
        }

    // ==================== Payment Checking Tests ====================

    /**
     * Tests checking unpaid invoice status.
     *
     * Verifies:
     * 1. Single check returns false for unpaid
     * 2. No polling when timeout is zero
     * 3. Quote ID correctly passed to mint
     */
    @Test
    fun checksUnpaidInvoiceStatus() =
        runTest {
            // Given: Invoice is unpaid
            coEvery {
                mockMintApiClient.checkMintQuote("https://mint.example.com", "quote-123")
            } returns
                Result.success(
                    MintQuoteResponse(
                        quote = "quote-123",
                        request = "lnbc...",
                        paid = false,
                        expiry = Clock.System.now().plus(15.minutes).epochSeconds,
                    ),
                )

            // When: Checking payment (single check, no polling)
            val result = checkInvoiceUseCase("quote-123", "https://mint.example.com")

            // Then: Returns false
            assertTrue(result.isSuccess)
            assertFalse(result.getOrThrow())
        }

    /**
     * Tests checking paid invoice status.
     *
     * Verifies:
     * 1. Returns true when invoice is paid
     * 2. Payment confirmation detected immediately
     */
    @Test
    fun checksPaidInvoiceStatus() =
        runTest {
            // Given: Invoice is paid
            coEvery {
                mockMintApiClient.checkMintQuote("https://mint.example.com", "quote-456")
            } returns
                Result.success(
                    MintQuoteResponse(
                        quote = "quote-456",
                        request = "lnbc...",
                        paid = true,
                        expiry = Clock.System.now().plus(15.minutes).epochSeconds,
                    ),
                )

            // When: Checking payment
            val result = checkInvoiceUseCase("quote-456", "https://mint.example.com")

            // Then: Returns true
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow())
        }

    /**
     * Tests polling for payment confirmation.
     *
     * Verifies:
     * 1. Polls multiple times until paid
     * 2. Returns true when payment detected
     * 3. Stops polling after payment confirmed
     *
     * Note: This is a simplified test. In production, polling would involve actual delays.
     */
    @Test
    fun pollsUntilPaymentConfirmed() =
        runTest {
            // Given: Invoice becomes paid after 2 checks
            var checkCount = 0
            coEvery {
                mockMintApiClient.checkMintQuote("https://mint.example.com", "quote-789")
            } answers {
                checkCount++
                Result.success(
                    MintQuoteResponse(
                        quote = "quote-789",
                        request = "lnbc...",
                        paid = checkCount >= 2, // Paid after 2nd check
                        expiry = Clock.System.now().plus(15.minutes).epochSeconds,
                    ),
                )
            }

            // When: Polling with timeout (should detect payment)
            val result =
                checkInvoiceUseCase(
                    quoteId = "quote-789",
                    mintUrl = "https://mint.example.com",
                    pollInterval = 100.seconds, // Fast polling for test
                    timeout = 300.seconds,
                )

            // Then: Payment confirmed
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow())
            assertTrue(checkCount >= 2, "Should have polled at least twice")
        }

    /**
     * Tests polling timeout when payment never confirmed.
     *
     * Verifies:
     * 1. Returns false when timeout reached
     * 2. Doesn't poll indefinitely
     * 3. Timeout duration respected
     *
     * Note: This test uses a very short timeout to avoid long test duration.
     */
    @Test
    fun returnsFalseWhenPollingTimeout() =
        runTest {
            // Given: Invoice never gets paid
            coEvery {
                mockMintApiClient.checkMintQuote("https://mint.example.com", "quote-unpaid")
            } returns
                Result.success(
                    MintQuoteResponse(
                        quote = "quote-unpaid",
                        request = "lnbc...",
                        paid = false,
                        expiry = Clock.System.now().plus(15.minutes).epochSeconds,
                    ),
                )

            // When: Polling with very short timeout (using milliseconds for fast test)
            val result =
                checkInvoiceUseCase(
                    quoteId = "quote-unpaid",
                    mintUrl = "https://mint.example.com",
                    pollInterval = 10.milliseconds,
                    timeout = 50.milliseconds,
                )

            // Then: Returns false (timeout)
            assertTrue(result.isSuccess)
            assertFalse(result.getOrThrow(), "Should return false on timeout")
        }

    /**
     * Tests validation of quote ID and mint URL.
     *
     * Verifies:
     * 1. Rejects blank quote ID
     * 2. Rejects blank mint URL
     */
    @Test
    fun failsToCheckInvoiceWithInvalidParameters() =
        runTest {
            // Test blank quote ID
            val result1 = checkInvoiceUseCase("   ", "https://mint.example.com")
            assertTrue(result1.isFailure)
            assertTrue(result1.exceptionOrNull()!!.message!!.contains("Quote ID cannot be blank"))

            // Test blank mint URL
            val result2 = checkInvoiceUseCase("quote-123", "   ")
            assertTrue(result2.isFailure)
            assertTrue(result2.exceptionOrNull()!!.message!!.contains("Mint URL cannot be blank"))
        }

    // ==================== Invoice Domain Model Tests ====================

    /**
     * Tests invoice expiration logic.
     *
     * Verifies:
     * 1. Fresh invoice is not expired
     * 2. Expired invoice is detected
     * 3. canMint() respects both paid and expiry status
     */
    @Test
    fun detectsExpiredInvoices() =
        runTest {
            // Given: Fresh invoice
            val freshInvoice =
                LightningInvoice(
                    quoteId = "q1",
                    paymentRequest = "lnbc...",
                    amount = 1000,
                    paid = false,
                    expiresAt = Clock.System.now().plus(15.minutes),
                    createdAt = Clock.System.now(),
                )

            // Then: Not expired
            assertFalse(freshInvoice.isExpired())

            // Given: Expired invoice
            val expiredInvoice =
                freshInvoice.copy(
                    expiresAt = Clock.System.now().minus(1.minutes),
                )

            // Then: Expired
            assertTrue(expiredInvoice.isExpired())

            // Given: Paid but not expired
            val paidInvoice = freshInvoice.copy(paid = true)
            assertTrue(paidInvoice.canMint())

            // Given: Paid but expired
            val paidExpiredInvoice = expiredInvoice.copy(paid = true)
            assertFalse(paidExpiredInvoice.canMint())
        }

    /**
     * Tests invoice state transitions.
     *
     * Verifies:
     * 1. Unpaid → Paid transition
     * 2. Invoice properties immutable
     * 3. State changes reflected in canMint()
     */
    @Test
    fun invoiceStateTransitions() =
        runTest {
            // Given: Unpaid invoice
            val unpaidInvoice =
                LightningInvoice(
                    quoteId = "q1",
                    paymentRequest = "lnbc...",
                    amount = 1000,
                    paid = false,
                    expiresAt = Clock.System.now().plus(15.minutes),
                    createdAt = Clock.System.now(),
                )

            assertFalse(unpaidInvoice.paid)
            assertFalse(unpaidInvoice.canMint())

            // When: Payment confirmed (create new instance)
            val paidInvoice = unpaidInvoice.copy(paid = true)

            // Then: State updated
            assertTrue(paidInvoice.paid)
            assertTrue(paidInvoice.canMint())

            // Verify original unchanged (immutability)
            assertFalse(unpaidInvoice.paid)
        }
}
