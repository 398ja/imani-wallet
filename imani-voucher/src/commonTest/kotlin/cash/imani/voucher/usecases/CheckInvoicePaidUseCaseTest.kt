package cash.imani.voucher.usecases

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.voucher.network.MintApiClient
import cash.imani.voucher.network.MintQuoteResponse
import io.ktor.client.HttpClient
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.js.JsName
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/**
 * Unit tests for CheckInvoicePaidUseCase.
 * Tests Lightning invoice payment confirmation via NUT-04 mint quote check.
 */
class CheckInvoicePaidUseCaseTest {
    /**
     * Tests that checkInvoicePaid returns true when invoice is paid (single check mode).
     */
    @Test
    @JsName("checkInvoiceReturnsTrueWhenPaid")
    fun `checkInvoice returns true when invoice is paid`() =
        runTest {
            // Given: Mock mint client returning paid invoice
            val mockMintClient =
                PollingFakeMintApiClient(
                    responses =
                        listOf(
                            Result.success(
                                MintQuoteResponse(
                                    quote = "quote-123",
                                    request = "lnbc1000n1...",
                                    paid = true,
                                    expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                                ),
                            ),
                        ),
                )

            val useCase = CheckInvoicePaidUseCase(mockMintClient)

            // When: Checking payment status (single check)
            val result = useCase(quoteId = "quote-123", mintUrl = "https://mint.example.com")

            // Then: Should return true
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow())
        }

    /**
     * Tests that checkInvoicePaid returns false when invoice is unpaid (single check mode).
     */
    @Test
    @JsName("checkInvoiceReturnsFalseWhenUnpaid")
    fun `checkInvoice returns false when invoice is unpaid`() =
        runTest {
            // Given: Mock mint client returning unpaid invoice
            val mockMintClient =
                PollingFakeMintApiClient(
                    responses =
                        listOf(
                            Result.success(
                                MintQuoteResponse(
                                    quote = "quote-123",
                                    request = "lnbc1000n1...",
                                    paid = false,
                                    expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                                ),
                            ),
                        ),
                )

            val useCase = CheckInvoicePaidUseCase(mockMintClient)

            // When: Checking payment status (single check)
            val result = useCase(quoteId = "quote-123", mintUrl = "https://mint.example.com")

            // Then: Should return false
            assertTrue(result.isSuccess)
            assertFalse(result.getOrThrow())
        }

    /**
     * Tests that checkInvoicePaid polls until payment confirmed.
     */
    @Test
    @JsName("checkInvoicePollsUntilPaid")
    fun `checkInvoice polls until payment confirmed`() =
        runTest {
            // Given: Mock mint client returning unpaid, then paid
            val mockMintClient =
                PollingFakeMintApiClient(
                    responses =
                        listOf(
                            Result.success(
                                MintQuoteResponse(
                                    quote = "quote-123",
                                    request = "lnbc1000n1...",
                                    paid = false,
                                    expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                                ),
                            ),
                            Result.success(
                                MintQuoteResponse(
                                    quote = "quote-123",
                                    request = "lnbc1000n1...",
                                    paid = true,
                                    expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                                ),
                            ),
                        ),
                )

            val useCase = CheckInvoicePaidUseCase(mockMintClient)

            // When: Polling with timeout
            val result =
                useCase(
                    quoteId = "quote-123",
                    mintUrl = "https://mint.example.com",
                    pollInterval = 100.milliseconds,
                    timeout = 5.seconds,
                )

            // Then: Should return true after polling
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow())
            // Verify we polled twice
            assertEquals(2, mockMintClient.callCount)
        }

    /**
     * Tests that checkInvoicePaid returns false when timeout reached before payment.
     */
    @Test
    @JsName("checkInvoiceTimesOut")
    fun `checkInvoice returns false when timeout reached`() =
        runTest {
            // Given: Mock mint client always returning unpaid
            val mockMintClient =
                PollingFakeMintApiClient(
                    responses =
                        listOf(
                            Result.success(
                                MintQuoteResponse(
                                    quote = "quote-123",
                                    request = "lnbc1000n1...",
                                    paid = false,
                                    expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                                ),
                            ),
                        ),
                    repeatLast = true,
                )

            val useCase = CheckInvoicePaidUseCase(mockMintClient)

            // When: Polling with short timeout
            val result =
                useCase(
                    quoteId = "quote-123",
                    mintUrl = "https://mint.example.com",
                    pollInterval = 100.milliseconds,
                    timeout = 300.milliseconds,
                )

            // Then: Should return false (timeout)
            assertTrue(result.isSuccess)
            assertFalse(result.getOrThrow())
        }

    /**
     * Tests that checkInvoicePaid rejects blank quote ID.
     */
    @Test
    @JsName("checkInvoiceRejectsBlankQuoteId")
    fun `checkInvoice rejects blank quote ID`() =
        runTest {
            // Given: Mock mint client
            val mockMintClient = PollingFakeMintApiClient()
            val useCase = CheckInvoicePaidUseCase(mockMintClient)

            // When: Checking with blank quote ID
            val result = useCase(quoteId = "", mintUrl = "https://mint.example.com")

            // Then: Should fail with IllegalArgumentException
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that checkInvoicePaid rejects blank mint URL.
     */
    @Test
    @JsName("checkInvoiceRejectsBlankMintUrl")
    fun `checkInvoice rejects blank mint URL`() =
        runTest {
            // Given: Mock mint client
            val mockMintClient = PollingFakeMintApiClient()
            val useCase = CheckInvoicePaidUseCase(mockMintClient)

            // When: Checking with blank URL
            val result = useCase(quoteId = "quote-123", mintUrl = "")

            // Then: Should fail with IllegalArgumentException
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that checkInvoicePaid propagates mint API errors.
     */
    @Test
    @JsName("checkInvoiceHandlesMintError")
    fun `checkInvoice handles mint API error`() =
        runTest {
            // Given: Mock mint client that returns error
            val mockMintClient =
                PollingFakeMintApiClient(
                    responses = listOf(Result.failure(Exception("Network error"))),
                )

            val useCase = CheckInvoicePaidUseCase(mockMintClient)

            // When: Checking payment status
            val result = useCase(quoteId = "quote-123", mintUrl = "https://mint.example.com")

            // Then: Should fail with network error
            assertTrue(result.isFailure)
            assertEquals("Network error", result.exceptionOrNull()?.message)
        }

    /**
     * Tests pollUntilPaid convenience method.
     */
    @Test
    @JsName("pollUntilPaidUsesContinuousPolling")
    fun `pollUntilPaid uses continuous polling`() =
        runTest {
            // Given: Mock mint client that returns paid on second call
            val mockMintClient =
                PollingFakeMintApiClient(
                    responses =
                        listOf(
                            Result.success(
                                MintQuoteResponse(
                                    quote = "quote-123",
                                    request = "lnbc1000n1...",
                                    paid = false,
                                    expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                                ),
                            ),
                            Result.success(
                                MintQuoteResponse(
                                    quote = "quote-123",
                                    request = "lnbc1000n1...",
                                    paid = true,
                                    expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                                ),
                            ),
                        ),
                )

            val useCase = CheckInvoicePaidUseCase(mockMintClient)

            // When: Using pollUntilPaid method
            val result =
                useCase.pollUntilPaid(
                    quoteId = "quote-123",
                    mintUrl = "https://mint.example.com",
                    pollInterval = 100.milliseconds,
                    timeout = 5.seconds,
                )

            // Then: Should return true
            assertTrue(result.isSuccess)
            assertTrue(result.getOrThrow())
        }
}

/**
 * Fake MintApiClient for testing polling behavior.
 * Returns responses in sequence, optionally repeating the last response.
 */
private class PollingFakeMintApiClient(
    private val responses: List<Result<MintQuoteResponse>> =
        listOf(
            Result.success(
                MintQuoteResponse(
                    quote = "test-quote",
                    request = "lnbc1000n1...",
                    paid = false,
                    expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                ),
            ),
        ),
    private val repeatLast: Boolean = false,
) : MintApiClient(
        HttpClient(),
        object : CryptoAdapter {
            override suspend fun generateRandomBytes(length: Int): ByteArray = ByteArray(length)

            override suspend fun sha256(data: ByteArray): ByteArray = data

            override suspend fun generateKeypair(): cash.imani.identity.crypto.KeyPair =
                cash.imani.identity.crypto.KeyPair(ByteArray(32), ByteArray(32))

            override suspend fun getPublicKey(privateKey: ByteArray): ByteArray = ByteArray(32)

            override suspend fun schnorrSign(
                privateKey: ByteArray,
                message: ByteArray,
            ): ByteArray = ByteArray(64)

            override suspend fun schnorrVerify(
                publicKey: ByteArray,
                message: ByteArray,
                signature: ByteArray,
            ): Boolean = true

            override suspend fun encryptNip44(
                plaintext: String,
                recipientPubkey: String,
                senderPrivkey: String,
            ): String = "encrypted"

            override suspend fun decryptNip44(
                ciphertext: String,
                senderPubkey: String,
                recipientPrivkey: String,
            ): String = "decrypted"
        },
    ) {
    var callCount = 0
        private set

    override suspend fun checkMintQuote(
        mintUrl: String,
        quoteId: String,
    ): Result<MintQuoteResponse> {
        val response =
            if (callCount < responses.size) {
                responses[callCount]
            } else if (repeatLast && responses.isNotEmpty()) {
                responses.last()
            } else {
                Result.failure(Exception("No more responses"))
            }
        callCount++
        return response
    }
}
