package cash.imani.voucher.usecases

import cash.imani.voucher.domain.Proof
import cash.imani.voucher.domain.VoucherRedemptionException
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.encoding.TokenEncoder
import cash.imani.voucher.network.MintApiClient
import cash.imani.voucher.repository.ProofRepository
import cash.imani.voucher.repository.VoucherRepository
import kotlinx.datetime.Clock

/**
 * Use case for redeeming vouchers.
 *
 * Voucher redemption flow:
 * 1. Decode Cashu token (V4 CBOR + Bech32)
 * 2. Check proof states with mint (verify not spent)
 * 3. Import proofs to wallet
 * 4. Create redemption record (optional, for tracking)
 *
 * @property voucherRepository Repository for voucher persistence
 * @property proofRepository Repository for proof management
 * @property mintApiClient HTTP client for Cashu mint API
 */
class RedeemVoucherUseCase(
    private val voucherRepository: VoucherRepository,
    private val proofRepository: ProofRepository,
    private val mintApiClient: MintApiClient,
) {
    /**
     * Redeems a voucher from its encoded token.
     *
     * @param token Cashu V4 token string
     * @param voucherId Optional voucher ID if redeeming a known voucher
     * @return Result containing redemption details or error
     * @throws VoucherRedemptionException if redemption fails
     */
    suspend operator fun invoke(
        token: String,
        voucherId: String? = null,
    ): Result<RedeemVoucherResult> =
        runCatching {
            // 1. Decode token
            val tokenData =
                try {
                    TokenEncoder.decodeV4(token)
                } catch (e: Exception) {
                    throw VoucherRedemptionException.InvalidToken("Failed to decode token: ${e.message}", e)
                }

            // 2. Check if this is a known voucher (for tracking)
            val storedVoucher = voucherId?.let { voucherRepository.getVoucher(it).getOrNull() }

            // 3. Validate expiration if voucher is known
            storedVoucher?.let { voucher ->
                if (voucher.isExpired()) {
                    throw VoucherRedemptionException.Expired(
                        voucher.voucherId,
                        voucher.expiresAt ?: 0,
                    )
                }
            }

            // 4. Check proof states with mint
            val secrets = tokenData.proofs.map { it.secret }
            val statesResponse =
                try {
                    mintApiClient.checkProofStates(tokenData.mint, secrets).getOrThrow()
                } catch (e: Exception) {
                    throw VoucherRedemptionException.StateCheckFailed(
                        "Failed to check proof states: ${e.message}",
                        e,
                    )
                }

            // 5. Filter for unspent proofs
            val unspentStates = statesResponse.states.filter { it.state == "UNSPENT" }
            if (unspentStates.isEmpty()) {
                throw VoucherRedemptionException.alreadyRedeemed(
                    storedVoucher?.voucherId ?: "unknown",
                )
            }

            // 6. Convert to domain Proof objects (all proofs, assuming they're unspent)
            // Note: In production, we'd need to map Y values back to secrets
            // Phase 2: Simplified - we assume all proofs in token are unspent
            val proofsToImport =
                tokenData.proofs
                    .map { tokenProof ->
                        Proof(
                            amount = tokenProof.amount,
                            secret = tokenProof.secret,
                            C = tokenProof.C,
                            id = tokenProof.id,
                        )
                    }

            // 7. Import proofs to wallet
            try {
                proofRepository.saveProofs(proofsToImport, tokenData.mint, tokenData.unit).getOrThrow()
            } catch (e: Exception) {
                throw VoucherRedemptionException.ImportFailed(
                    "Failed to import proofs: ${e.message}",
                    e,
                )
            }

            // 8. Update voucher status if known
            storedVoucher?.let { voucher ->
                voucherRepository.updateVoucherStatus(voucher.voucherId, VoucherStatus.REDEEMED)
            }

            // 9. Calculate total amount received
            val amountReceived = proofsToImport.sumOf { it.amount.toLong() }

            RedeemVoucherResult(
                voucherId = storedVoucher?.voucherId ?: "redeemed-${generateRedemptionId()}",
                status = VoucherStatus.REDEEMED,
                message = "Redeemed $amountReceived ${tokenData.unit} from ${tokenData.mint}",
                proofsReceived = proofsToImport,
                amountReceived = amountReceived,
                mintUrl = tokenData.mint,
                unit = tokenData.unit,
                memo = tokenData.memo,
                redeemedAt = Clock.System.now(),
            )
        }

    /**
     * Generates a unique redemption ID.
     *
     * @return Timestamp-based redemption ID
     */
    private fun generateRedemptionId(): String = Clock.System.now().toEpochMilliseconds().toString()
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
