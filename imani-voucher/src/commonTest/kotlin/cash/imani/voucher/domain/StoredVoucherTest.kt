package cash.imani.voucher.domain

import kotlin.js.JsName
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.seconds

/**
 * Unit tests for StoredVoucher domain model.
 * Tests voucher lifecycle, expiration logic, and redemption rules.
 */
class StoredVoucherTest {
    /**
     * Test data builder for creating StoredVoucher instances with customizable fields.
     * Provides sensible defaults for common test scenarios.
     */
    private fun createVoucher(
        status: VoucherStatus = VoucherStatus.ISSUED,
        expiresAt: Long? = null,
        issuedAt: Instant = Clock.System.now(),
    ): StoredVoucher {
        return StoredVoucher(
            voucherId = "voucher-1",
            issuerId = "issuer-1",
            unit = "sat",
            faceValue = 1000,
            expiresAt = expiresAt,
            memo = "Test voucher",
            issuerSignature = "signature",
            issuerPublicKey = "0".repeat(64),
            issuedAt = issuedAt,
            status = status,
        )
    }

    /**
     * Tests that vouchers without expiry date never expire,
     * supporting indefinite validity for certain voucher types.
     */
    @Test
    @JsName("isExpiredReturnsFalseWhenNoExpiryDate")
    fun `isExpired returns false when no expiry date`() {
        // Given: Voucher without expiry date
        val voucher = createVoucher(expiresAt = null)

        // When: Checking if expired
        val result = voucher.isExpired()

        // Then: Should not be expired
        assertFalse(result)
    }

    /**
     * Tests that vouchers with future expiry date are not expired,
     * allowing for time-bound redemption windows.
     */
    @Test
    @JsName("isExpiredReturnsFalseWhenExpiryIsInFuture")
    fun `isExpired returns false when expiry is in future`() {
        // Given: Voucher expiring in 1 day
        val futureTime = Clock.System.now().plus(1.days)
        val voucher = createVoucher(expiresAt = futureTime.epochSeconds)

        // When: Checking if expired
        val result = voucher.isExpired()

        // Then: Should not be expired
        assertFalse(result)
    }

    /**
     * Tests that vouchers past their expiry date are marked expired,
     * preventing redemption of stale vouchers.
     */
    @Test
    @JsName("isExpiredReturnsTrueWhenExpiryIsInPast")
    fun `isExpired returns true when expiry is in past`() {
        // Given: Voucher expired 1 day ago
        val pastTime = Clock.System.now().minus(1.days)
        val voucher = createVoucher(expiresAt = pastTime.epochSeconds)

        // When: Checking if expired
        val result = voucher.isExpired()

        // Then: Should be expired
        assertTrue(result)
    }

    /**
     * Tests that issued, non-expired vouchers are active,
     * indicating they can be used for operations.
     */
    @Test
    @JsName("isActiveReturnsTrueForIssuedNonExpiredVoucher")
    fun `isActive returns true for issued non-expired voucher`() {
        // Given: Issued voucher expiring in future
        val voucher =
            createVoucher(
                status = VoucherStatus.ISSUED,
                expiresAt = Clock.System.now().plus(1.days).epochSeconds,
            )

        // When: Checking if active
        val result = voucher.isActive()

        // Then: Should be active
        assertTrue(result)
    }

    /**
     * Tests that redeemed vouchers are not active,
     * preventing double-spending of vouchers.
     */
    @Test
    @JsName("isActiveReturnsFalseForRedeemedVoucher")
    fun `isActive returns false for redeemed voucher`() {
        // Given: Redeemed voucher
        val voucher =
            createVoucher(
                status = VoucherStatus.REDEEMED,
                expiresAt = Clock.System.now().plus(1.days).epochSeconds,
            )

        // When: Checking if active
        val result = voucher.isActive()

        // Then: Should not be active
        assertFalse(result)
    }

    /**
     * Tests that expired vouchers are not active,
     * enforcing expiration policy.
     */
    @Test
    @JsName("isActiveReturnsFalseForExpiredVoucher")
    fun `isActive returns false for expired voucher`() {
        // Given: Expired voucher with ISSUED status
        val voucher =
            createVoucher(
                status = VoucherStatus.ISSUED,
                expiresAt = Clock.System.now().minus(1.days).epochSeconds,
            )

        // When: Checking if active
        val result = voucher.isActive()

        // Then: Should not be active
        assertFalse(result)
    }

    /**
     * Tests that revoked vouchers are not active,
     * supporting voucher cancellation workflows.
     */
    @Test
    @JsName("isActiveReturnsFalseForRevokedVoucher")
    fun `isActive returns false for revoked voucher`() {
        // Given: Revoked voucher
        val voucher = createVoucher(status = VoucherStatus.REVOKED)

        // When: Checking if active
        val result = voucher.isActive()

        // Then: Should not be active
        assertFalse(result)
    }

    /**
     * Tests that issued, non-expired vouchers can be redeemed,
     * implementing basic redemption eligibility.
     */
    @Test
    @JsName("canRedeemReturnsTrueForIssuedVoucher")
    fun `canRedeem returns true for issued voucher`() {
        // Given: Issued voucher expiring in future
        val voucher =
            createVoucher(
                status = VoucherStatus.ISSUED,
                expiresAt = Clock.System.now().plus(1.days).epochSeconds,
            )

        // When: Checking if redeemable
        val result = voucher.canRedeem()

        // Then: Should be redeemable
        assertTrue(result)
    }

    /**
     * Tests that delivered vouchers can still be redeemed,
     * supporting delivery tracking without blocking redemption.
     */
    @Test
    @JsName("canRedeemReturnsTrueForDeliveredVoucher")
    fun `canRedeem returns true for delivered voucher`() {
        // Given: Delivered voucher expiring in future
        val voucher =
            createVoucher(
                status = VoucherStatus.DELIVERED,
                expiresAt = Clock.System.now().plus(1.days).epochSeconds,
            )

        // When: Checking if redeemable
        val result = voucher.canRedeem()

        // Then: Should be redeemable
        assertTrue(result)
    }

    /**
     * Tests that already redeemed vouchers cannot be redeemed again,
     * preventing double-spending.
     */
    @Test
    @JsName("canRedeemReturnsFalseForRedeemedVoucher")
    fun `canRedeem returns false for redeemed voucher`() {
        // Given: Already redeemed voucher
        val voucher = createVoucher(status = VoucherStatus.REDEEMED)

        // When: Checking if redeemable
        val result = voucher.canRedeem()

        // Then: Should not be redeemable
        assertFalse(result)
    }

    /**
     * Tests that expired vouchers cannot be redeemed,
     * enforcing temporal validity constraints.
     */
    @Test
    @JsName("canRedeemReturnsFalseForExpiredVoucher")
    fun `canRedeem returns false for expired voucher`() {
        // Given: Voucher expired 1 second ago
        val voucher =
            createVoucher(
                status = VoucherStatus.ISSUED,
                expiresAt = Clock.System.now().minus(1.seconds).epochSeconds,
            )

        // When: Checking if redeemable
        val result = voucher.canRedeem()

        // Then: Should not be redeemable
        assertFalse(result)
    }

    /**
     * Tests that revoked vouchers cannot be redeemed,
     * supporting issuer-initiated cancellation.
     */
    @Test
    @JsName("canRedeemReturnsFalseForRevokedVoucher")
    fun `canRedeem returns false for revoked voucher`() {
        // Given: Revoked voucher
        val voucher = createVoucher(status = VoucherStatus.REVOKED)

        // When: Checking if redeemable
        val result = voucher.canRedeem()

        // Then: Should not be redeemable
        assertFalse(result)
    }
}
