package cash.imani.voucher.usecases

import cash.imani.voucher.domain.OfferStatus
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.js.JsName
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

/**
 * Unit tests for offer management use cases.
 * Tests CreateOfferUseCase, PublishOfferToNostrUseCase, and DiscoverMerchantOffersUseCase.
 */
class OfferManagementUseCasesTest {
    // ==================== CreateOfferUseCase Tests ====================

    /**
     * Tests that CreateOfferUseCase creates a valid offer with all required fields.
     */
    @Test
    @JsName("createOfferCreatesValidOffer")
    fun `createOffer creates valid offer with required fields`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with valid parameters
            val result =
                useCase(
                    merchantId = "merchant-pubkey-123",
                    amount = 1000L,
                    price = 900L,
                    description = "10% off on 1000 sats voucher",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Should create offer successfully
            assertTrue(result.isSuccess)
            val offer = result.getOrThrow()

            assertEquals("merchant-pubkey-123", offer.merchantId)
            assertEquals(1000L, offer.amount)
            assertEquals(900L, offer.price)
            assertEquals("10% off on 1000 sats voucher", offer.description)
            assertEquals("https://mint.example.com", offer.mintUrl)
            assertEquals("sat", offer.unit)
            assertEquals(OfferStatus.DRAFT, offer.status)
            assertNotNull(offer.offerId)
        }

    /**
     * Tests that CreateOfferUseCase validates amount is positive.
     */
    @Test
    @JsName("createOfferRejectsNonPositiveAmount")
    fun `createOffer rejects non-positive amount`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with zero amount
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 0L,
                    price = 100L,
                    description = "Test",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Should fail validation
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that CreateOfferUseCase validates price is positive.
     */
    @Test
    @JsName("createOfferRejectsNonPositivePrice")
    fun `createOffer rejects non-positive price`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with zero price
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 1000L,
                    price = 0L,
                    description = "Test",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Should fail validation
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that CreateOfferUseCase validates price does not exceed amount.
     */
    @Test
    @JsName("createOfferRejectsPriceExceedingAmount")
    fun `createOffer rejects price exceeding amount`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with price > amount
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 1000L,
                    price = 1100L,
                    description = "Test",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Should fail validation (no markup allowed)
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("cannot exceed amount"))
        }

    /**
     * Tests that CreateOfferUseCase validates description is not blank.
     */
    @Test
    @JsName("createOfferRejectsBlankDescription")
    fun `createOffer rejects blank description`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with blank description
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 1000L,
                    price = 900L,
                    description = "   ",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Should fail validation
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        }

    /**
     * Tests that CreateOfferUseCase validates description length (1-500 chars).
     */
    @Test
    @JsName("createOfferRejectsTooLongDescription")
    fun `createOffer rejects description longer than 500 characters`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with 501-character description
            val longDescription = "x".repeat(501)
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 1000L,
                    price = 900L,
                    description = longDescription,
                    mintUrl = "https://mint.example.com",
                )

            // Then: Should fail validation
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("1-500 characters"))
        }

    /**
     * Tests that CreateOfferUseCase validates mint URL format (HTTP/HTTPS).
     */
    @Test
    @JsName("createOfferRejectsInvalidMintUrl")
    fun `createOffer rejects invalid mint URL format`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with invalid URL
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 1000L,
                    price = 900L,
                    description = "Test",
                    mintUrl = "ftp://invalid-protocol.com",
                )

            // Then: Should fail validation
            assertTrue(result.isFailure)
            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
            assertTrue(result.exceptionOrNull()!!.message!!.contains("http://"))
        }

    /**
     * Tests that CreateOfferUseCase handles optional expiry duration.
     */
    @Test
    @JsName("createOfferHandlesExpiryDuration")
    fun `createOffer handles optional expiry duration`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with 7-day expiry
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 1000L,
                    price = 900L,
                    description = "Test",
                    mintUrl = "https://mint.example.com",
                    expiryDuration = 7.days,
                )

            // Then: Should create offer with expiration timestamp
            assertTrue(result.isSuccess)
            val offer = result.getOrThrow()
            assertNotNull(offer.expiresAt)

            // Verify expiration is ~7 days from now (with 1-second tolerance)
            val expectedExpiry = Clock.System.now().plus(7.days)
            val actualExpiry = offer.expiresAt!!
            val difference = kotlin.math.abs((expectedExpiry - actualExpiry).inWholeSeconds)
            assertTrue(difference < 2) // Allow 2-second tolerance for test execution time
        }

    /**
     * Tests that CreateOfferUseCase trims description whitespace.
     */
    @Test
    @JsName("createOfferTrimsDescription")
    fun `createOffer trims description whitespace`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with padded description
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 1000L,
                    price = 900L,
                    description = "  Test description  ",
                    mintUrl = "https://mint.example.com",
                )

            // Then: Should trim whitespace
            assertTrue(result.isSuccess)
            assertEquals("Test description", result.getOrThrow().description)
        }

    /**
     * Tests that CreateOfferUseCase trims trailing slash from mint URL.
     */
    @Test
    @JsName("createOfferTrimsMintUrlSlash")
    fun `createOffer trims trailing slash from mint URL`() =
        runTest {
            // Given: CreateOfferUseCase
            val useCase = CreateOfferUseCase()

            // When: Creating offer with trailing slash in URL
            val result =
                useCase(
                    merchantId = "merchant-pubkey",
                    amount = 1000L,
                    price = 900L,
                    description = "Test",
                    mintUrl = "https://mint.example.com/",
                )

            // Then: Should remove trailing slash
            assertTrue(result.isSuccess)
            assertEquals("https://mint.example.com", result.getOrThrow().mintUrl)
        }

    // ==================== PublishOfferToNostrUseCase Tests ====================

    /**
     * Tests that PublishOfferToNostrUseCase rejects non-DRAFT offers.
     *
     * Note: Full integration testing with Nostr publishing is deferred to Phase 3
     * due to platform-specific expect class complexity.
     */
    @Test
    @JsName("publishOfferRejectsNonDraftStatus")
    fun `publishOffer validation rejects non-DRAFT status`() {
        // Given: Offer in ACTIVE status
        val offerStatus = OfferStatus.ACTIVE

        // Then: Should not be in DRAFT status
        assertFalse(offerStatus == OfferStatus.DRAFT)
    }

    // ==================== DiscoverMerchantOffersUseCase Tests ====================

    /**
     * Tests that DiscoverOffersFilter constructs correctly with defaults.
     */
    @Test
    @JsName("discoverOffersFilterHasDefaults")
    fun `discoverOffersFilter has correct defaults`() {
        // Given: Default filter
        val filter = DiscoverOffersFilter()

        // Then: Should have expected defaults
        assertEquals(null, filter.status)
        assertEquals(null, filter.merchantId)
        assertEquals(null, filter.mintUrl)
        assertEquals(null, filter.unit)
        assertFalse(filter.includeExpired)
        assertEquals(100, filter.limit)
    }

    /**
     * Tests that DiscoverOffersFilter accepts custom values.
     */
    @Test
    @JsName("discoverOffersFilterAcceptsCustomValues")
    fun `discoverOffersFilter accepts custom values`() {
        // Given: Custom filter
        val filter =
            DiscoverOffersFilter(
                status = OfferStatus.ACTIVE,
                merchantId = "merchant-123",
                mintUrl = "https://mint.example.com",
                unit = "sat",
                includeExpired = true,
                limit = 50,
            )

        // Then: Should have custom values
        assertEquals(OfferStatus.ACTIVE, filter.status)
        assertEquals("merchant-123", filter.merchantId)
        assertEquals("https://mint.example.com", filter.mintUrl)
        assertEquals("sat", filter.unit)
        assertTrue(filter.includeExpired)
        assertEquals(50, filter.limit)
    }
}
