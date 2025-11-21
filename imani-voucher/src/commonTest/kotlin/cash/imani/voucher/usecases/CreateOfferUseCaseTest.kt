package cash.imani.voucher.usecases

import cash.imani.voucher.domain.OfferStatus
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

/**
 * Unit tests for CreateOfferUseCase.
 *
 * Tests offer creation validation, offer ID generation, and business rules.
 */
class CreateOfferUseCaseTest {
    private val useCase = CreateOfferUseCase()

    // ==================== Success Cases ====================

    /**
     * Tests successful offer creation with valid parameters.
     */
    @Test
    fun createsOfferSuccessfullyWithValidParameters() =
        runTest {
            // Given: Valid offer parameters
            val merchantId = "npub1abc123"
            val amount = 1000L
            val price = 900L
            val description = "Buy 1000 sats voucher, get 10% off!"
            val mintUrl = "https://mint.example.com"

            // When: Creating offer
            val result =
                useCase(
                    merchantId = merchantId,
                    amount = amount,
                    price = price,
                    description = description,
                    mintUrl = mintUrl,
                )

            // Then: Offer created successfully
            assertTrue(result.isSuccess)
            val offer = result.getOrThrow()
            assertNotNull(offer.offerId)
            assertEquals(merchantId, offer.merchantId)
            assertEquals(amount, offer.amount)
            assertEquals(price, offer.price)
            assertEquals(description, offer.description)
            assertEquals(mintUrl, offer.mintUrl)
            assertEquals("sat", offer.unit)
            assertEquals(OfferStatus.DRAFT, offer.status)
            assertNotNull(offer.createdAt)
        }

    /**
     * Tests offer creation with custom unit.
     */
    @Test
    fun createsOfferWithCustomUnit() =
        runTest {
            // Given: Offer with custom unit
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 100L,
                    price = 100L,
                    description = "USD voucher",
                    mintUrl = "https://mint.example.com",
                    unit = "usd",
                )

            // Then: Offer created with custom unit
            assertTrue(result.isSuccess)
            assertEquals("usd", result.getOrThrow().unit)
        }

    /**
     * Tests offer creation with expiry duration.
     */
    @Test
    fun createsOfferWithExpiryDuration() =
        runTest {
            // Given: Offer with 7-day expiry
            val before = Clock.System.now()
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 1000L,
                    description = "Limited time offer",
                    mintUrl = "https://mint.example.com",
                    expiryDuration = 7.days,
                )
            val after = Clock.System.now()

            // Then: Expiry set correctly
            assertTrue(result.isSuccess)
            val offer = result.getOrThrow()
            assertNotNull(offer.expiresAt)

            // Verify expiry is ~7 days from now
            val expectedExpiry = before + 7.days
            val actualExpiry = offer.expiresAt!!
            assertTrue(actualExpiry >= expectedExpiry - 1.days) // Allow 1 day tolerance
            assertTrue(actualExpiry <= after + 7.days + 1.days)
        }

    /**
     * Tests offer creation with metadata.
     */
    @Test
    fun createsOfferWithMetadata() =
        runTest {
            // Given: Offer with custom metadata
            val metadata = mapOf("category" to "food", "featured" to "true")
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 500L,
                    price = 400L,
                    description = "Food voucher",
                    mintUrl = "https://mint.example.com",
                    metadata = metadata,
                )

            // Then: Metadata preserved
            assertTrue(result.isSuccess)
            assertEquals(metadata, result.getOrThrow().metadata)
        }

    /**
     * Tests offer creation with discounted price.
     */
    @Test
    fun createsOfferWithDiscount() =
        runTest {
            // Given: 20% discount offer
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 800L, // 20% off
                    description = "20% discount voucher",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Discount calculated correctly
            assertTrue(result.isSuccess)
            val offer = result.getOrThrow()
            assertEquals(1000L, offer.amount)
            assertEquals(800L, offer.price)
            assertEquals(20, offer.discountPercentage())
        }

    /**
     * Tests offer creation with price equal to amount (no discount).
     */
    @Test
    fun createsOfferWithNoDiscount() =
        runTest {
            // Given: Price equals amount
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 1000L,
                    description = "Full price voucher",
                    mintUrl = "https://mint.example.com",
                )

            // Then: No discount
            assertTrue(result.isSuccess)
            val offer = result.getOrThrow()
            assertEquals(0, offer.discountPercentage())
        }

    // ==================== Validation Tests ====================

    /**
     * Tests validation of blank merchant ID.
     */
    @Test
    fun failsWhenMerchantIdIsBlank() =
        runTest {
            // Given: Blank merchant ID
            val result =
                useCase(
                    merchantId = "   ",
                    amount = 1000L,
                    price = 900L,
                    description = "Valid description",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()
            assertNotNull(exception)
            assertTrue(exception is IllegalArgumentException)
            assertTrue(exception.message!!.contains("Merchant ID cannot be blank"))
        }

    /**
     * Tests validation of non-positive amount.
     */
    @Test
    fun failsWhenAmountIsZero() =
        runTest {
            // Given: Amount is zero
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 0L,
                    price = 0L,
                    description = "Invalid amount",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("Amount must be positive"))
        }

    /**
     * Tests validation of negative amount.
     */
    @Test
    fun failsWhenAmountIsNegative() =
        runTest {
            // Given: Negative amount
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = -100L,
                    price = -50L,
                    description = "Negative amount",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("Amount must be positive"))
        }

    /**
     * Tests validation of non-positive price.
     */
    @Test
    fun failsWhenPriceIsZero() =
        runTest {
            // Given: Price is zero
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 0L,
                    description = "Free voucher",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("Price must be positive"))
        }

    /**
     * Tests validation of price exceeding amount (markup not allowed).
     */
    @Test
    fun failsWhenPriceExceedsAmount() =
        runTest {
            // Given: Price > amount (markup)
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 1100L, // 10% markup not allowed
                    description = "Markup offer",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()!!
            assertTrue(exception.message!!.contains("Price (1100) cannot exceed amount (1000)"))
            assertTrue(exception.message!!.contains("Offers can only discount vouchers"))
        }

    /**
     * Tests validation of blank description.
     */
    @Test
    fun failsWhenDescriptionIsBlank() =
        runTest {
            // Given: Blank description
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = "   ",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("Description cannot be blank"))
        }

    /**
     * Tests validation of description length (max 500 chars).
     */
    @Test
    fun failsWhenDescriptionTooLong() =
        runTest {
            // Given: Description > 500 chars
            val longDesc = "a".repeat(501)
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = longDesc,
                    mintUrl = "https://mint.example.com",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("Description must be 1-500 characters"))
        }

    /**
     * Tests validation of blank mint URL.
     */
    @Test
    fun failsWhenMintUrlIsBlank() =
        runTest {
            // Given: Blank mint URL
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = "Valid description",
                    mintUrl = "   ",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("Mint URL cannot be blank"))
        }

    /**
     * Tests validation of invalid mint URL scheme.
     */
    @Test
    fun failsWhenMintUrlInvalidScheme() =
        runTest {
            // Given: Mint URL without http/https
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = "Valid description",
                    mintUrl = "ftp://mint.example.com",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()!!
            assertTrue(exception.message!!.contains("Mint URL must start with http:// or https://"))
        }

    /**
     * Tests validation of blank unit.
     */
    @Test
    fun failsWhenUnitIsBlank() =
        runTest {
            // Given: Blank unit
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = "Valid description",
                    mintUrl = "https://mint.example.com",
                    unit = "  ",
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("Unit cannot be blank"))
        }

    /**
     * Tests validation of negative expiry duration.
     */
    @Test
    fun failsWhenExpiryDurationIsNegative() =
        runTest {
            // Given: Negative expiry duration
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = "Valid description",
                    mintUrl = "https://mint.example.com",
                    expiryDuration = (-1).days,
                )

            // Then: Validation fails
            assertTrue(result.isFailure)
            val exception = result.exceptionOrNull()!!
            assertTrue(exception.message!!.contains("Expiry duration cannot be negative"))
        }

    // ==================== Edge Cases ====================

    /**
     * Tests that offer ID is unique for each invocation.
     */
    @Test
    fun generatesUniqueOfferIds() =
        runTest {
            // Given: Multiple offers with same parameters
            val results =
                (1..10).map {
                    useCase(
                        merchantId = "npub1merchant",
                        amount = 1000L,
                        price = 900L,
                        description = "Offer $it",
                        mintUrl = "https://mint.example.com",
                    )
                }

            // Then: All offer IDs are unique
            val offerIds = results.mapNotNull { it.getOrNull()?.offerId }
            assertEquals(10, offerIds.size)
            assertEquals(offerIds.size, offerIds.toSet().size) // No duplicates
        }

    /**
     * Tests description trimming.
     */
    @Test
    fun trimsDescriptionWhitespace() =
        runTest {
            // Given: Description with leading/trailing whitespace
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = "  Trimmed description  ",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Whitespace trimmed
            assertTrue(result.isSuccess)
            assertEquals("Trimmed description", result.getOrThrow().description)
        }

    /**
     * Tests mint URL trailing slash removal.
     */
    @Test
    fun removesMintUrlTrailingSlash() =
        runTest {
            // Given: Mint URL with trailing slash
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = "Valid description",
                    mintUrl = "https://mint.example.com/",
                )

            // Then: Trailing slash removed
            assertTrue(result.isSuccess)
            assertEquals("https://mint.example.com", result.getOrThrow().mintUrl)
        }

    /**
     * Tests offer with HTTP (not HTTPS) mint URL.
     */
    @Test
    fun acceptsHttpMintUrl() =
        runTest {
            // Given: HTTP mint URL (allowed for testing)
            val result =
                useCase(
                    merchantId = "npub1merchant",
                    amount = 1000L,
                    price = 900L,
                    description = "Valid description",
                    mintUrl = "http://localhost:3338",
                )

            // Then: HTTP accepted
            assertTrue(result.isSuccess)
            assertEquals("http://localhost:3338", result.getOrThrow().mintUrl)
        }
}
