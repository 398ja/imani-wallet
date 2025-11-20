package cash.imani.voucher.adapter

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.repository.VoucherRepository
import cash.imani.voucher.usecases.IssueVoucherRequest
import cash.imani.voucher.usecases.IssueVoucherResult
import cash.imani.voucher.usecases.IssueVoucherUseCase
import cash.imani.voucher.usecases.RedeemVoucherResult
import cash.imani.voucher.usecases.RedeemVoucherUseCase

/**
 * Web (JS) implementation of VoucherAdapter.
 *
 * Delegates to existing Kotlin/JS use cases and repositories instead of wrapping
 * Java libraries (which aren't available on the web platform).
 *
 * **Architecture**:
 * - Uses existing IssueVoucherUseCase and RedeemVoucherUseCase
 * - Stores vouchers in IndexedDB (browser persistence)
 * - Backs up to Nostr relays using nostr-tools library
 * - Implements crypto using Web Crypto API
 *
 * **Code Reuse**: ~70% from existing KMP use cases, ~30% web-specific (storage, crypto)
 *
 * @param issueVoucherUseCase Existing use case for voucher issuance
 * @param redeemVoucherUseCase Existing use case for voucher redemption
 * @param voucherRepository Repository for local voucher storage (IndexedDB)
 * @param nostrClient Client for Nostr relay operations (nostr-tools)
 * @param cryptoAdapter Web Crypto API adapter for signature verification
 *
 * @see IssueVoucherUseCase
 * @see RedeemVoucherUseCase
 * @see cash.imani.voucher.repository.NostrVoucherRepository
 */
class WebVoucherAdapter(
    private val issueVoucherUseCase: IssueVoucherUseCase,
    private val redeemVoucherUseCase: RedeemVoucherUseCase,
    private val voucherRepository: VoucherRepository,
    private val nostrClient: NostrVoucherClient,
    private val cryptoAdapter: CryptoAdapter,
) : VoucherAdapter {
    /**
     * Issues a voucher by delegating to IssueVoucherUseCase.
     *
     * Flow:
     * 1. IssueVoucherUseCase selects proofs, creates P2PK secret, swaps with mint
     * 2. Voucher stored in IndexedDB via VoucherRepository
     * 3. (Future) Backup to Nostr happens in separate operation
     *
     * @param request Voucher issuance parameters
     * @return Result containing issued voucher and token
     */
    override suspend fun issueVoucher(request: IssueVoucherRequest): Result<IssueVoucherResult> {
        println("[WebVoucherAdapter] Issuing voucher via IssueVoucherUseCase")
        return issueVoucherUseCase(request)
    }

    /**
     * Redeems a voucher by delegating to RedeemVoucherUseCase.
     *
     * Flow:
     * 1. RedeemVoucherUseCase decodes token, checks proof states, imports to wallet
     * 2. Voucher status updated to REDEEMED in IndexedDB
     * 3. (Future) Redemption event published to Nostr
     *
     * @param token Cashu V4 token string
     * @param voucherId Optional voucher ID if redeeming a known voucher
     * @return Result containing redemption details
     */
    override suspend fun redeemVoucher(
        token: String,
        voucherId: String?,
    ): Result<RedeemVoucherResult> {
        println("[WebVoucherAdapter] Redeeming voucher via RedeemVoucherUseCase")
        return redeemVoucherUseCase(token)
    }

    /**
     * Revokes a voucher by updating its status and publishing to Nostr.
     *
     * Flow:
     * 1. Update voucher status to REVOKED in local storage
     * 2. Publish revocation event to Nostr relays (NIP-33 replacement)
     *
     * Note: This does NOT recover the ecash. The proofs are permanently burned.
     *
     * @param voucherId ID of voucher to revoke
     * @return Result indicating success or error
     */
    override suspend fun revokeVoucher(voucherId: String): Result<Unit> =
        runCatching {
            println("[WebVoucherAdapter] Revoking voucher $voucherId")

            // Update local status
            voucherRepository.updateVoucherStatus(voucherId, VoucherStatus.REVOKED).getOrThrow()

            // Publish to Nostr (NIP-33 replacement event)
            nostrClient.updateVoucherStatus(voucherId, VoucherStatus.REVOKED).getOrThrow()

            println("[WebVoucherAdapter] Successfully revoked voucher $voucherId")
        }

    /**
     * Verifies a voucher's issuer signature using Web Crypto API.
     *
     * Verification checks:
     * 1. Issuer signature is valid (Schnorr/Ed25519 via Web Crypto)
     * 2. Voucher data matches signed message
     * 3. Issuer public key is valid
     *
     * @param voucher Voucher to verify
     * @return Result containing true if valid, false otherwise
     */
    override suspend fun verifyVoucher(voucher: StoredVoucher): Result<Boolean> =
        runCatching {
            println("[WebVoucherAdapter] Verifying voucher ${voucher.voucherId}")

            // Reconstruct signed message
            val message =
                buildString {
                    append(voucher.voucherId)
                    append(voucher.issuerId)
                    append(voucher.unit)
                    append(voucher.faceValue)
                    append(voucher.expiresAt ?: "")
                    append(voucher.memo ?: "")
                }

            // Parse signature and public key from hex
            val signatureBytes = hexToBytes(voucher.issuerSignature)
            val publicKeyBytes = hexToBytes(voucher.issuerPublicKey)
            val messageBytes = message.encodeToByteArray()

            // Verify using Web Crypto API
            val isValid =
                cryptoAdapter.schnorrVerify(
                    publicKey = publicKeyBytes,
                    message = messageBytes,
                    signature = signatureBytes,
                )

            if (isValid) {
                println("[WebVoucherAdapter] Voucher ${voucher.voucherId} signature verified successfully")
            } else {
                println("[WebVoucherAdapter] Warning: Voucher ${voucher.voucherId} signature verification failed")
            }

            isValid
        }

    /**
     * Lists all vouchers from local storage.
     *
     * Returns vouchers sorted by issuedAt (most recent first).
     * Includes all statuses: ISSUED, DELIVERED, REDEEMED, REVOKED, EXPIRED.
     *
     * @return Result containing list of vouchers
     */
    override suspend fun listVouchers(): Result<List<StoredVoucher>> {
        println("[WebVoucherAdapter] Listing all vouchers from IndexedDB")
        return voucherRepository.getAllVouchers()
    }

    /**
     * Queries vouchers by status from local storage.
     *
     * @param status Status to filter by
     * @return Result containing filtered vouchers
     */
    override suspend fun queryVouchersByStatus(status: VoucherStatus): Result<List<StoredVoucher>> {
        println("[WebVoucherAdapter] Querying vouchers with status: $status")
        return voucherRepository.getVouchersByStatus(status)
    }

    /**
     * Backs up all vouchers to Nostr relays using encrypted events.
     *
     * Flow:
     * 1. Fetch all vouchers from local storage
     * 2. Publish each voucher to Nostr relays (NIP-33 kind 30078)
     * 3. Content encrypted with NIP-44 (future enhancement)
     *
     * @return Result indicating success or error
     */
    override suspend fun backupToNostr(): Result<Unit> =
        runCatching {
            println("[WebVoucherAdapter] Backing up vouchers to Nostr")

            val vouchers = voucherRepository.getAllVouchers().getOrThrow()

            vouchers.forEach { voucher ->
                nostrClient.publishVoucher(voucher).getOrThrow()
            }

            println("[WebVoucherAdapter] Successfully backed up ${vouchers.size} vouchers to Nostr")
        }

    /**
     * Restores vouchers from Nostr relays.
     *
     * Flow:
     * 1. Query Nostr relays for voucher events (NIP-33 kind 30078)
     * 2. Decrypt events using NIP-44 (future enhancement)
     * 3. Import vouchers to local storage
     *
     * @return Result containing list of restored vouchers
     */
    override suspend fun restoreFromNostr(): Result<List<StoredVoucher>> =
        runCatching {
            println("[WebVoucherAdapter] Restoring vouchers from Nostr")

            // Query all issued vouchers from Nostr
            val issuedVouchers = nostrClient.queryVouchersByStatus(VoucherStatus.ISSUED).getOrThrow()

            // Import to local storage
            issuedVouchers.forEach { voucher ->
                voucherRepository.saveVoucher(voucher).getOrElse { error ->
                    println("[WebVoucherAdapter] Warning: Failed to restore voucher ${voucher.voucherId}: ${error.message}")
                }
            }

            println("[WebVoucherAdapter] Successfully restored ${issuedVouchers.size} vouchers from Nostr")

            issuedVouchers
        }

    /**
     * Converts hex string to byte array.
     *
     * @param hex Hex-encoded string (must be even length)
     * @return Decoded byte array
     */
    private fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "Hex string must have even length" }
        return hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
}
