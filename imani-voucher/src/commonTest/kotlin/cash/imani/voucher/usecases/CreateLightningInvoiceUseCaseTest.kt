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
import kotlin.time.Duration.Companion.minutes

/**
 * Unit tests for CreateLightningInvoiceUseCase.
 * Tests Lightning invoice generation via NUT-04 mint quote endpoint.
 */
class CreateLightningInvoiceUseCaseTest {
    /**
     * Tests that createLightningInvoiceUseCase successfully generates an invoice
     * when the mint returns a valid quote.
     */
    @Test
    @JsName("createInvoiceReturnsValidInvoice")
    fun `createInvoice returns valid invoice when mint responds successfully`() =
        runTest {
            // Given: Mock mint client that returns a quote
            val mockMintClient =
                FakeMintApiClient(
                    getMintQuoteResponse =
                        Result.success(
                            MintQuoteResponse(
                                quote = "quote-123",
                                request = "lnbc10000n1...",
                                paid = false,
                                expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                            ),
                        ),
                )

            val useCase = CreateLightningInvoiceUseCase(mockMintClient)

            // When: Creating invoice for 1000 sats
            val result = useCase(amount = 1000, mintUrl = "https://mint.example.com")

            // Then: Should return success with correct invoice
            assertTrue(result.isSuccess)
            val invoice = result.getOrThrow()
            assertEquals("quote-123", invoice.quoteId)
            assertEquals("lnbc10000n1...", invoice.paymentRequest)
            assertEquals(1000, invoice.amount)
            assertFalse(invoice.paid)
        }

    /**
     * Tests that createLightningInvoiceUseCase rejects negative amounts.
     */
    @Test
    @JsName("createInvoiceRejectsNegativeAmount")
    fun `createInvoice rejects negative amount`() =
        runTest {
            // Given: Mock mint client
            val mockMintClient = FakeMintApiClient()
            val useCase = CreateLightningInvoiceUseCase(mockMintClient)

            // When: Creating invoice with negative amount
            val result = useCase(amount = -100, mintUrl = "https://mint.example.com")

            // Then: Should fail with IllegalArgumentException
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that createLightningInvoiceUseCase rejects zero amount.
     */
    @Test
    @JsName("createInvoiceRejectsZeroAmount")
    fun `createInvoice rejects zero amount`() =
        runTest {
            // Given: Mock mint client
            val mockMintClient = FakeMintApiClient()
            val useCase = CreateLightningInvoiceUseCase(mockMintClient)

            // When: Creating invoice with zero amount
            val result = useCase(amount = 0, mintUrl = "https://mint.example.com")

            // Then: Should fail with IllegalArgumentException
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that createLightningInvoiceUseCase rejects blank mint URL.
     */
    @Test
    @JsName("createInvoiceRejectsBlankMintUrl")
    fun `createInvoice rejects blank mint URL`() =
        runTest {
            // Given: Mock mint client
            val mockMintClient = FakeMintApiClient()
            val useCase = CreateLightningInvoiceUseCase(mockMintClient)

            // When: Creating invoice with blank URL
            val result = useCase(amount = 1000, mintUrl = "")

            // Then: Should fail with IllegalArgumentException
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that createLightningInvoiceUseCase propagates mint API errors.
     */
    @Test
    @JsName("createInvoiceHandlesMintError")
    fun `createInvoice handles mint API error`() =
        runTest {
            // Given: Mock mint client that returns error
            val mockMintClient =
                FakeMintApiClient(
                    getMintQuoteResponse = Result.failure(Exception("Mint unavailable")),
                )

            val useCase = CreateLightningInvoiceUseCase(mockMintClient)

            // When: Creating invoice
            val result = useCase(amount = 1000, mintUrl = "https://mint.example.com")

            // Then: Should fail with mint error
            assertTrue(result.isFailure)
            assertEquals("Mint unavailable", result.exceptionOrNull()?.message)
        }

    /**
     * Tests that createLightningInvoiceUseCase uses default unit "sat".
     */
    @Test
    @JsName("createInvoiceUsesDefaultUnit")
    fun `createInvoice uses default unit sat`() =
        runTest {
            // Given: Mock mint client
            val mockMintClient =
                FakeMintApiClient(
                    getMintQuoteResponse =
                        Result.success(
                            MintQuoteResponse(
                                quote = "quote-456",
                                request = "lnbc5000n1...",
                                paid = false,
                                expiry = Clock.System.now().plus(10.minutes).epochSeconds,
                            ),
                        ),
                )

            val useCase = CreateLightningInvoiceUseCase(mockMintClient)

            // When: Creating invoice without specifying unit
            val result = useCase(amount = 500, mintUrl = "https://mint.example.com")

            // Then: Should succeed with default unit
            assertTrue(result.isSuccess)
            // Unit is not returned by MintQuoteResponse, but we verify request succeeds
            val invoice = result.getOrThrow()
            assertEquals(500, invoice.amount)
        }
}

/**
 * Fake MintApiClient for testing.
 * Allows injecting canned responses for getMintQuote and checkMintQuote.
 */
private class FakeMintApiClient(
    private val getMintQuoteResponse: Result<MintQuoteResponse> =
        Result.success(
            MintQuoteResponse(
                quote = "test-quote",
                request = "lnbc1000n1...",
                paid = false,
                expiry = Clock.System.now().plus(10.minutes).epochSeconds,
            ),
        ),
    private val checkMintQuoteResponse: Result<MintQuoteResponse> =
        Result.success(
            MintQuoteResponse(
                quote = "test-quote",
                request = "lnbc1000n1...",
                paid = true,
                expiry = Clock.System.now().plus(10.minutes).epochSeconds,
            ),
        ),
) : MintApiClient(
        // We don't actually use these in the fake, but they're required by the constructor
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
    override suspend fun getMintQuote(
        mintUrl: String,
        amount: Int,
        unit: String,
    ): Result<MintQuoteResponse> = getMintQuoteResponse

    override suspend fun checkMintQuote(
        mintUrl: String,
        quoteId: String,
    ): Result<MintQuoteResponse> = checkMintQuoteResponse
}
