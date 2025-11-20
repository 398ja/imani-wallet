package cash.imani.voucher.adapter

import cash.imani.voucher.domain.BackupException
import cash.imani.voucher.domain.RestoreException
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.usecases.IssueVoucherRequest
import cash.imani.voucher.usecases.IssueVoucherResult
import cash.imani.voucher.usecases.RedeemVoucherResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.datetime.Instant
import xyz.tcheeric.wallet.core.VoucherService
import xyz.tcheeric.wallet.core.exception.WalletOperationException
import xyz.tcheeric.wallet.core.state.StoredVoucher as JavaStoredVoucher
import xyz.tcheeric.wallet.core.VoucherService.IssueVoucherRequest as JavaIssueVoucherRequest
import xyz.tcheeric.wallet.core.VoucherService.IssueVoucherResult as JavaIssueVoucherResult

/**
 * JVM implementation of VoucherAdapter that wraps cashu-client VoucherService.
 *
 * This adapter provides a Kotlin-friendly interface to the existing Java VoucherService,
 * enabling 100% code reuse from cashu-client while maintaining the platform-agnostic
 * VoucherAdapter API for KMP compatibility.
 *
 * ## Architecture
 *
 * ```
 * Kotlin (imani-wallet)                     Java (cashu-client)
 * ┌──────────────────────┐                 ┌─────────────────────┐
 * │  VoucherAdapter      │                 │  VoucherService     │
 * │  (interface)         │                 │  (interface)        │
 * └──────────────────────┘                 └─────────────────────┘
 *           ▲                                        ▲
 *           │                                        │
 * ┌──────────────────────┐                 ┌─────────────────────┐
 * │  JvmVoucherAdapter   │─────wraps──────>│ VoucherServiceImpl  │
 * │  (this class)        │                 │                     │
 * └──────────────────────┘                 └─────────────────────┘
 *           │                                        │
 *           │                                        ├─> SendService (Nostr NIP-17/44)
 *           │                                        ├─> TokenCodec (CBOR encoding)
 *           │                                        └─> NostrGatewayService
 *           │
 *    Type Conversion (Kotlin ↔ Java)
 * ```
 *
 * ## Type Conversion
 *
 * This adapter handles bidirectional type conversion:
 * - **Kotlin → Java**: Request types (IssueVoucherRequest)
 * - **Java → Kotlin**: Response types (IssueVoucherResult, StoredVoucher, etc.)
 * - **Instant conversion**: kotlinx.datetime.Instant ↔ java.time.Instant
 *
 * ## Thread Safety
 *
 * All VoucherService calls are blocking (Java), so we use `withContext(Dispatchers.IO)`
 * to move execution off the main/UI thread and onto IO-optimized thread pool.
 *
 * ## Exception Handling
 *
 * Java exceptions (WalletOperationException) are caught and wrapped in Kotlin Result.
 *
 * @property voucherService cashu-client VoucherService implementation
 *
 * @see VoucherAdapter The platform-agnostic interface this adapter implements
 * @see xyz.tcheeric.wallet.core.VoucherService The Java service being wrapped
 */
class JvmVoucherAdapter(
    private val voucherService: VoucherService,
) : VoucherAdapter {
    override suspend fun issueVoucher(request: IssueVoucherRequest): Result<IssueVoucherResult> =
        withContext(Dispatchers.IO) {
            runCatching {
                // Convert Kotlin request to Java
                val javaRequest =
                    JavaIssueVoucherRequest(
                        request.amount,
                        request.unit,
                        request.mintUrl,
                        request.expiresInDays,
                        request.memo,
                    )

                // Call Java VoucherService
                val javaResult = voucherService.issueAndBackup(javaRequest)

                // Convert Java result to Kotlin
                javaResult.toKotlin()
            }.recoverCatching { e ->
                when (e) {
                    is WalletOperationException ->
                        throw cash.imani.voucher.domain.VoucherIssuanceException.SwapFailed(
                            "Voucher issuance failed: ${e.message}",
                            e,
                        )

                    else -> throw e
                }
            }
        }

    override suspend fun redeemVoucher(
        token: String,
        voucherId: String?,
    ): Result<RedeemVoucherResult> =
        withContext(Dispatchers.IO) {
            runCatching {
                // cashu-client VoucherService doesn't have a dedicated redeem method
                // The redemption is handled by the wallet's receive() method which imports proofs
                // For now, return a simple result indicating that redemption is handled
                // by the existing RedeemVoucherUseCase which uses MintApiClient directly
                throw NotImplementedError(
                    "JVM voucher redemption is handled by RedeemVoucherUseCase. " +
                        "This adapter delegates to existing use case implementation.",
                )
            }
        }

    override suspend fun revokeVoucher(voucherId: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                // cashu-client VoucherService doesn't expose revoke as a public method yet
                // This functionality exists in the Nostr ledger but isn't exposed in the current API
                throw NotImplementedError(
                    "Voucher revocation not yet exposed in cashu-client VoucherService API. " +
                        "Will be implemented in future cashu-client version.",
                )
            }
        }

    override suspend fun verifyVoucher(voucher: StoredVoucher): Result<Boolean> =
        withContext(Dispatchers.IO) {
            runCatching {
                // cashu-client VoucherService doesn't expose verify as a public method yet
                // Verification logic exists but isn't exposed in the current API
                throw NotImplementedError(
                    "Voucher signature verification not yet exposed in cashu-client VoucherService API. " +
                        "Will be implemented in future cashu-client version.",
                )
            }
        }

    override suspend fun listVouchers(): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherService.listVouchers().map { it.toKotlin() }
            }
        }

    override suspend fun queryVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                // cashu-client doesn't have queryByStatus, so filter listVouchers()
                voucherService.listVouchers()
                    .map { it.toKotlin() }
                    .filter { it.status == status }
            }
        }

    override suspend fun backupToNostr(): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                voucherService.backupToNostr()
            }.recoverCatching { e ->
                when (e) {
                    is WalletOperationException ->
                        throw BackupException(
                            "Nostr backup failed: ${e.message}",
                            e,
                        )

                    else -> throw e
                }
            }
        }

    override suspend fun restoreFromNostr(): Result<List<StoredVoucher>> =
        withContext(Dispatchers.IO) {
            runCatching {
                // Restore returns count, but we need the actual vouchers
                voucherService.restoreFromNostr()

                // After restore, list all vouchers to return them
                voucherService.listVouchers().map { it.toKotlin() }
            }.recoverCatching { e ->
                when (e) {
                    is WalletOperationException ->
                        throw RestoreException(
                            "Nostr restore failed: ${e.message}",
                            e,
                        )

                    else -> throw e
                }
            }
        }
}

// ==================== Type Conversion Extensions ====================

/**
 * Converts Java IssueVoucherResult to Kotlin IssueVoucherResult.
 */
private fun JavaIssueVoucherResult.toKotlin(): IssueVoucherResult =
    IssueVoucherResult(
        voucher = this.voucher().toKotlin(),
        token = this.token(),
        backedUp = this.backedUp(),
        message = this.message() ?: "Voucher issued successfully",
    )

/**
 * Converts Java StoredVoucher to Kotlin StoredVoucher.
 */
private fun JavaStoredVoucher.toKotlin(): StoredVoucher =
    StoredVoucher(
        voucherId = this.voucherId(),
        issuerId = this.issuerId(),
        unit = this.unit(),
        faceValue = this.faceValue(),
        // expiresAt and memo are already nullable in Java (Long?, String?)
        expiresAt = this.expiresAt(),
        memo = this.memo(),
        issuerSignature = this.issuerSignature(),
        issuerPublicKey = this.issuerPublicKey(),
        issuedAt = this.issuedAt().toKotlinInstant(),
        status = this.status().toKotlin(),
        // Token is generated by Kotlin client, not stored in Java StoredVoucher
        token = null,
        // cashu-client doesn't have delivery/redemption metadata yet
        deliveryMetadata = null,
        redemptionMetadata = null,
    )

/**
 * Converts Java VoucherStatus string to Kotlin VoucherStatus enum.
 */
private fun String.toKotlin(): VoucherStatus =
    when (this.uppercase()) {
        "ISSUED" -> VoucherStatus.ISSUED
        "DELIVERED" -> VoucherStatus.DELIVERED
        "REDEEMED" -> VoucherStatus.REDEEMED
        "REVOKED" -> VoucherStatus.REVOKED
        "EXPIRED" -> VoucherStatus.EXPIRED
        else -> VoucherStatus.ISSUED // Default fallback
    }

/**
 * Converts java.time.Instant to kotlinx.datetime.Instant.
 */
private fun java.time.Instant.toKotlinInstant(): Instant = Instant.fromEpochSeconds(this.epochSecond, this.nano)
