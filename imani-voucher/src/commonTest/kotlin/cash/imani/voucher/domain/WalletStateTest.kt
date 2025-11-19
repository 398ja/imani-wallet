package cash.imani.voucher.domain

import kotlin.js.JsName
import kotlinx.datetime.Clock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

/**
 * Unit tests for WalletState domain model.
 * Tests voucher filtering, balance calculation, and state aggregation.
 */
class WalletStateTest {
    /**
     * Test data builder for creating StoredVoucher instances with customizable fields.
     * Provides sensible defaults for common test scenarios.
     */
    private fun createVoucher(
        id: String,
        unit: String = "sat",
        faceValue: Long = 1000,
        status: VoucherStatus = VoucherStatus.ISSUED,
        expiresAt: Long? = null,
    ): StoredVoucher {
        return StoredVoucher(
            voucherId = id,
            issuerId = "issuer-1",
            unit = unit,
            faceValue = faceValue,
            expiresAt = expiresAt,
            memo = null,
            issuerSignature = "sig",
            issuerPublicKey = "0".repeat(64),
            issuedAt = Clock.System.now(),
            status = status,
        )
    }

    /**
     * Test data builder for creating Proof instances with customizable amount.
     * Uses consistent keyset ID unless overridden.
     */
    private fun createProof(
        amount: Int,
        id: String = "keyset-1",
    ): Proof {
        return Proof(
            amount = amount,
            secret = "secret-$amount",
            C = "C-$amount",
            id = id,
        )
    }

    /**
     * Tests that getActiveVouchers filters out redeemed, revoked, and expired
     * vouchers, returning only usable vouchers.
     */
    @Test
    @JsName("getActiveVouchersReturnsOnlyActiveVouchers")
    fun `getActiveVouchers returns only active vouchers`() {
        // Given: Mix of active, redeemed, expired, and delivered vouchers
        val now = Clock.System.now()
        val vouchers =
            listOf(
                createVoucher("v1", status = VoucherStatus.ISSUED),
                createVoucher("v2", status = VoucherStatus.REDEEMED),
                createVoucher("v3", status = VoucherStatus.ISSUED, expiresAt = now.minus(1.days).epochSeconds),
                createVoucher("v4", status = VoucherStatus.DELIVERED),
            )

        val walletState =
            WalletState(
                vouchers = vouchers,
                proofs = emptyList(),
                lastUpdated = now,
            )

        // When: Getting active vouchers
        val activeVouchers = walletState.getActiveVouchers()

        // Then: Should return only the issued, non-expired voucher
        assertEquals(1, activeVouchers.size)
        assertEquals("v1", activeVouchers[0].voucherId)
    }

    /**
     * Tests that getActiveVoucherValue sums voucher values grouped by unit,
     * supporting multi-currency wallet state tracking.
     */
    @Test
    @JsName("getActiveVoucherValueGroupsByUnit")
    fun `getActiveVoucherValue groups by unit`() {
        // Given: Vouchers in multiple units with mixed statuses
        val vouchers =
            listOf(
                createVoucher("v1", unit = "sat", faceValue = 1000, status = VoucherStatus.ISSUED),
                createVoucher("v2", unit = "sat", faceValue = 2000, status = VoucherStatus.ISSUED),
                createVoucher("v3", unit = "usd", faceValue = 10, status = VoucherStatus.ISSUED),
                createVoucher("v4", unit = "sat", faceValue = 500, status = VoucherStatus.REDEEMED),
            )

        val walletState =
            WalletState(
                vouchers = vouchers,
                proofs = emptyList(),
                lastUpdated = Clock.System.now(),
            )

        // When: Getting active voucher values
        val voucherValues = walletState.getActiveVoucherValue()

        // Then: Should sum by unit, excluding redeemed voucher
        assertEquals(3000L, voucherValues["sat"])
        assertEquals(10L, voucherValues["usd"])
    }

    /**
     * Tests that getActiveVoucherValue returns empty map when wallet
     * has no active vouchers, handling edge case gracefully.
     */
    @Test
    @JsName("getActiveVoucherValueReturnsEmptyMapWhenNoActiveVouchers")
    fun `getActiveVoucherValue returns empty map when no active vouchers`() {
        // Given: Only redeemed and revoked vouchers
        val vouchers =
            listOf(
                createVoucher("v1", status = VoucherStatus.REDEEMED),
                createVoucher("v2", status = VoucherStatus.REVOKED),
            )

        val walletState =
            WalletState(
                vouchers = vouchers,
                proofs = emptyList(),
                lastUpdated = Clock.System.now(),
            )

        // When: Getting active voucher values
        val voucherValues = walletState.getActiveVoucherValue()

        // Then: Should return empty map
        assertTrue(voucherValues.isEmpty())
    }

    /**
     * Tests that getTotalBalance returns empty map in Phase 0,
     * as proof-based balance calculation is deferred to Phase 1+.
     */
    @Test
    @JsName("getTotalBalanceReturnsEmptyMapForPhase0")
    fun `getTotalBalance returns empty map for Phase 0`() {
        // Given: Wallet with multiple proofs
        val proofs =
            listOf(
                createProof(100),
                createProof(200),
                createProof(500),
            )

        val walletState =
            WalletState(
                vouchers = emptyList(),
                proofs = proofs,
                lastUpdated = Clock.System.now(),
            )

        // When: Getting total balance
        val balance = walletState.getTotalBalance()

        // Then: Phase 0 returns empty map (placeholder implementation)
        assertTrue(balance.isEmpty())
    }
}
