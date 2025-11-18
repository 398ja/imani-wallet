package cash.imani.voucher.domain

import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.seconds

class StoredVoucherTest {

    private fun createVoucher(
        status: VoucherStatus = VoucherStatus.ISSUED,
        expiresAt: Long? = null,
        issuedAt: Instant = Clock.System.now()
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
            status = status
        )
    }

    @Test
    fun `isExpired returns false when no expiry date`() {
        val voucher = createVoucher(expiresAt = null)
        assertFalse(voucher.isExpired())
    }

    @Test
    fun `isExpired returns false when expiry is in future`() {
        val futureTime = Clock.System.now().plus(1.days)
        val voucher = createVoucher(expiresAt = futureTime.epochSeconds)
        assertFalse(voucher.isExpired())
    }

    @Test
    fun `isExpired returns true when expiry is in past`() {
        val pastTime = Clock.System.now().minus(1.days)
        val voucher = createVoucher(expiresAt = pastTime.epochSeconds)
        assertTrue(voucher.isExpired())
    }

    @Test
    fun `isActive returns true for issued non-expired voucher`() {
        val voucher = createVoucher(
            status = VoucherStatus.ISSUED,
            expiresAt = Clock.System.now().plus(1.days).epochSeconds
        )
        assertTrue(voucher.isActive())
    }

    @Test
    fun `isActive returns false for redeemed voucher`() {
        val voucher = createVoucher(
            status = VoucherStatus.REDEEMED,
            expiresAt = Clock.System.now().plus(1.days).epochSeconds
        )
        assertFalse(voucher.isActive())
    }

    @Test
    fun `isActive returns false for expired voucher`() {
        val voucher = createVoucher(
            status = VoucherStatus.ISSUED,
            expiresAt = Clock.System.now().minus(1.days).epochSeconds
        )
        assertFalse(voucher.isActive())
    }

    @Test
    fun `isActive returns false for revoked voucher`() {
        val voucher = createVoucher(status = VoucherStatus.REVOKED)
        assertFalse(voucher.isActive())
    }

    @Test
    fun `canRedeem returns true for issued voucher`() {
        val voucher = createVoucher(
            status = VoucherStatus.ISSUED,
            expiresAt = Clock.System.now().plus(1.days).epochSeconds
        )
        assertTrue(voucher.canRedeem())
    }

    @Test
    fun `canRedeem returns true for delivered voucher`() {
        val voucher = createVoucher(
            status = VoucherStatus.DELIVERED,
            expiresAt = Clock.System.now().plus(1.days).epochSeconds
        )
        assertTrue(voucher.canRedeem())
    }

    @Test
    fun `canRedeem returns false for redeemed voucher`() {
        val voucher = createVoucher(status = VoucherStatus.REDEEMED)
        assertFalse(voucher.canRedeem())
    }

    @Test
    fun `canRedeem returns false for expired voucher`() {
        val voucher = createVoucher(
            status = VoucherStatus.ISSUED,
            expiresAt = Clock.System.now().minus(1.seconds).epochSeconds
        )
        assertFalse(voucher.canRedeem())
    }

    @Test
    fun `canRedeem returns false for revoked voucher`() {
        val voucher = createVoucher(status = VoucherStatus.REVOKED)
        assertFalse(voucher.canRedeem())
    }
}
