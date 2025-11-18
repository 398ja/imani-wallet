package cash.imani.voucher.domain

import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.days

class WalletStateTest {

    private fun createVoucher(
        id: String,
        unit: String = "sat",
        faceValue: Long = 1000,
        status: VoucherStatus = VoucherStatus.ISSUED,
        expiresAt: Long? = null
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
            status = status
        )
    }

    private fun createProof(amount: Int, id: String = "keyset-1"): Proof {
        return Proof(
            amount = amount,
            secret = "secret-$amount",
            C = "C-$amount",
            id = id
        )
    }

    @Test
    fun `getActiveVouchers returns only active vouchers`() {
        val now = Clock.System.now()
        val vouchers = listOf(
            createVoucher("v1", status = VoucherStatus.ISSUED),
            createVoucher("v2", status = VoucherStatus.REDEEMED),
            createVoucher("v3", status = VoucherStatus.ISSUED, expiresAt = now.minus(1.days).epochSeconds),
            createVoucher("v4", status = VoucherStatus.DELIVERED)
        )

        val walletState = WalletState(
            vouchers = vouchers,
            proofs = emptyList(),
            lastUpdated = now
        )

        val activeVouchers = walletState.getActiveVouchers()
        assertEquals(1, activeVouchers.size)
        assertEquals("v1", activeVouchers[0].voucherId)
    }

    @Test
    fun `getActiveVoucherValue groups by unit`() {
        val vouchers = listOf(
            createVoucher("v1", unit = "sat", faceValue = 1000, status = VoucherStatus.ISSUED),
            createVoucher("v2", unit = "sat", faceValue = 2000, status = VoucherStatus.ISSUED),
            createVoucher("v3", unit = "usd", faceValue = 10, status = VoucherStatus.ISSUED),
            createVoucher("v4", unit = "sat", faceValue = 500, status = VoucherStatus.REDEEMED) // Should not count
        )

        val walletState = WalletState(
            vouchers = vouchers,
            proofs = emptyList(),
            lastUpdated = Clock.System.now()
        )

        val voucherValues = walletState.getActiveVoucherValue()
        assertEquals(3000L, voucherValues["sat"])
        assertEquals(10L, voucherValues["usd"])
    }

    @Test
    fun `getActiveVoucherValue returns empty map when no active vouchers`() {
        val vouchers = listOf(
            createVoucher("v1", status = VoucherStatus.REDEEMED),
            createVoucher("v2", status = VoucherStatus.REVOKED)
        )

        val walletState = WalletState(
            vouchers = vouchers,
            proofs = emptyList(),
            lastUpdated = Clock.System.now()
        )

        val voucherValues = walletState.getActiveVoucherValue()
        assertTrue(voucherValues.isEmpty())
    }

    @Test
    fun `getTotalBalance returns empty map for Phase 0`() {
        val proofs = listOf(
            createProof(100),
            createProof(200),
            createProof(500)
        )

        val walletState = WalletState(
            vouchers = emptyList(),
            proofs = proofs,
            lastUpdated = Clock.System.now()
        )

        // Phase 0 implementation returns empty map (placeholder)
        val balance = walletState.getTotalBalance()
        assertTrue(balance.isEmpty())
    }
}
