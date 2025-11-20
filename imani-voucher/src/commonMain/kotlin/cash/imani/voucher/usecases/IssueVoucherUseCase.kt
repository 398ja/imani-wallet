package cash.imani.voucher.usecases

import cash.imani.voucher.adapter.VoucherAdapter
import cash.imani.voucher.domain.StoredVoucher

/**
 * Use case for issuing vouchers.
 *
 * **Phase 2.4.1 Refactoring**: Simplified to thin wrapper around VoucherAdapter.
 * All business logic moved to platform-specific adapters:
 * - JvmVoucherAdapter: Wraps cashu-client Java libraries
 * - WebVoucherAdapter: Implements full logic for web platform
 *
 * Voucher issuance flow (delegated to adapter):
 * 1. Select proofs from wallet (FIFO coin selection)
 * 2. Create P2PK secret if recipient specified (NUT-11)
 * 3. Blind secrets and swap proofs with mint (NUT-03)
 * 4. Unblind signatures to get new proofs
 * 5. Sign voucher with issuer's identity key
 * 6. Store voucher locally
 * 7. Encode token for sharing (V4 CBOR + Bech32)
 *
 * @property voucherAdapter Platform-specific voucher adapter
 * @see cash.imani.voucher.adapter.VoucherAdapter
 * @see cash.imani.voucher.adapter.WebVoucherAdapter
 * @see cash.imani.voucher.adapter.JvmVoucherAdapter
 */
class IssueVoucherUseCase(
    private val voucherAdapter: VoucherAdapter,
) {
    /**
     * Issues a new voucher by delegating to VoucherAdapter.
     *
     * @param request Voucher issuance parameters
     * @return Result containing issued voucher details or error
     */
    suspend operator fun invoke(request: IssueVoucherRequest): Result<IssueVoucherResult> =
        voucherAdapter.issueVoucher(request)
}

/**
 * Request parameters for voucher issuance.
 *
 * @property amount Amount in smallest unit (e.g., satoshis)
 * @property unit Unit of account (e.g., "sat")
 * @property mintUrl URL of the Cashu mint
 * @property expiresInDays Optional expiration in days from now
 * @property memo Optional human-readable memo
 * @property lockToPubkey Optional recipient public key for P2PK locking
 */
data class IssueVoucherRequest(
    val amount: Long,
    val unit: String = "sat",
    val mintUrl: String,
    val expiresInDays: Int? = null,
    val memo: String? = null,
    val lockToPubkey: String? = null,
)

/**
 * Result of voucher issuance.
 *
 * @property voucher The issued voucher with signature
 * @property token Encoded Cashu token for sharing
 * @property backedUp Whether voucher has been backed up
 * @property message Human-readable success message
 */
data class IssueVoucherResult(
    val voucher: StoredVoucher,
    val token: String,
    val backedUp: Boolean,
    val message: String,
)
