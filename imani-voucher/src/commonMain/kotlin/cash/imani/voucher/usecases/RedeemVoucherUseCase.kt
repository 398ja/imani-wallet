package cash.imani.voucher.usecases

import cash.imani.voucher.adapter.VoucherAdapter
import cash.imani.voucher.domain.Proof
import cash.imani.voucher.domain.VoucherStatus

/**
 * Use case for redeeming vouchers.
 *
 * **Phase 2.4.2 Refactoring**: Simplified to thin wrapper around VoucherAdapter.
 * All business logic moved to platform-specific adapters:
 * - JvmVoucherAdapter: Wraps cashu-client Java libraries
 * - WebVoucherAdapter: Implements full logic for web platform
 *
 * Voucher redemption flow (delegated to adapter):
 * 1. Decode Cashu token (V4 CBOR + Bech32)
 * 2. Check proof states with mint (verify not spent)
 * 3. Import proofs to wallet
 * 4. Create redemption record (optional, for tracking)
 *
 * @property voucherAdapter Platform-specific voucher adapter
 * @see cash.imani.voucher.adapter.VoucherAdapter
 * @see cash.imani.voucher.adapter.WebVoucherAdapter
 * @see cash.imani.voucher.adapter.JvmVoucherAdapter
 */
class RedeemVoucherUseCase(
    private val voucherAdapter: VoucherAdapter,
) {
    /**
     * Redeems a voucher by delegating to VoucherAdapter.
     *
     * @param token Cashu V4 token string
     * @param voucherId Optional voucher ID if redeeming a known voucher
     * @return Result containing redemption details or error
     */
    suspend operator fun invoke(
        token: String,
        voucherId: String? = null,
    ): Result<RedeemVoucherResult> = voucherAdapter.redeemVoucher(token, voucherId)
}

/**
 * Result of voucher redemption.
 *
 * @property voucherId ID of the redeemed voucher (or generated ID)
 * @property status Redemption status (should be REDEEMED)
 * @property message Human-readable success message
 * @property proofsReceived List of proofs imported to wallet
 * @property amountReceived Total amount received
 * @property mintUrl Mint URL where proofs are valid
 * @property unit Unit of account
 * @property memo Optional memo from the voucher
 * @property redeemedAt Timestamp of redemption
 */
data class RedeemVoucherResult(
    val voucherId: String,
    val status: VoucherStatus,
    val message: String,
    val proofsReceived: List<Proof>,
    val amountReceived: Long,
    val mintUrl: String,
    val unit: String,
    val memo: String? = null,
    val redeemedAt: kotlinx.datetime.Instant,
)
