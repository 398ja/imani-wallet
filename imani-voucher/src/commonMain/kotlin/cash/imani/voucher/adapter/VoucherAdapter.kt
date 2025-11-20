package cash.imani.voucher.adapter

import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.usecases.IssueVoucherRequest
import cash.imani.voucher.usecases.IssueVoucherResult
import cash.imani.voucher.usecases.RedeemVoucherResult

/**
 * Platform-agnostic voucher operations adapter.
 *
 * This interface provides a unified API for voucher management across platforms:
 * - **JVM/Android**: Wraps cashu-client VoucherService (100% code reuse)
 * - **Web**: Delegates to existing use cases (IssueVoucherUseCase, RedeemVoucherUseCase)
 *
 * ## Architecture Decision: Adapter Pattern
 *
 * We chose the Adapter Pattern over direct use case delegation because:
 * 1. **Platform Optimization**: JVM can reuse battle-tested cashu-client code (VoucherService,
 *    SendService, TokenCodec, NostrGateway) without reimplementing complex Nostr/crypto logic
 * 2. **Simplified Dependencies**: Each platform has ONE voucher dependency (VoucherAdapter)
 *    instead of 5+ use cases, reducing DI complexity
 * 3. **Consistent API**: Uniform interface across platforms despite different implementations
 * 4. **Future Extensibility**: Easy to add platform-specific optimizations (e.g., native
 *    crypto, different storage backends) without changing consumer code
 *
 * ## Implementation Notes
 *
 * ### JvmVoucherAdapter
 * - Wraps cashu-client `VoucherService`, `SendService`, `TokenCodec`
 * - Uses `withContext(Dispatchers.IO)` for blocking Java calls
 * - Converts between Kotlin and Java types
 * - Leverages cashu-client's Nostr integration (NIP-17, NIP-44 encryption)
 * - ~90% code reuse from existing cashu-client implementation
 *
 * ### WebVoucherAdapter
 * - Delegates to existing Kotlin use cases (IssueVoucherUseCase, RedeemVoucherUseCase)
 * - Uses Web Crypto API via JS interop
 * - Stores data in IndexedDB (browser persistence)
 * - Implements Nostr integration using nostr-tools library
 *
 * ## Methods Overview
 *
 * - **Core Operations**: issue, redeem, revoke, verify, list, query
 * - **Nostr Backup/Restore**: Encrypted backups using NIP-17 + NIP-44
 * - **Status Management**: Track voucher lifecycle (ISSUED → DELIVERED → REDEEMED)
 *
 * ## Code Reuse from cashu-client
 *
 * | Feature | cashu-client Class | Reuse % |
 * |---------|-------------------|---------|
 * | Issue Vouchers | VoucherService.issueAndBackup() | 100% |
 * | Redeem Vouchers | VoucherService.receive() | 100% |
 * | Revoke Vouchers | VoucherService.revoke() | 100% |
 * | Verify Signatures | VoucherService.verify() | 100% |
 * | Nostr Backup | SendService (NIP-17 + NIP-44) | 100% |
 * | Nostr Restore | VoucherService.refreshStatus() | 100% |
 * | Token Encoding | TokenCodec | 100% |
 *
 * @see cash.imani.voucher.adapter.JvmVoucherAdapter JVM implementation (wraps cashu-client)
 * @see cash.imani.voucher.adapter.WebVoucherAdapter Web implementation (delegates to use cases)
 */
interface VoucherAdapter {
    /**
     * Issues a new voucher with optional P2PK locking.
     *
     * Flow:
     * 1. Select proofs from wallet (coin selection algorithm)
     * 2. Create P2PK secret if recipient specified (NUT-11)
     * 3. Blind secrets and swap proofs with mint (NUT-03)
     * 4. Sign voucher with issuer's identity key
     * 5. Store voucher locally
     * 6. (JVM only) Backup to Nostr using NIP-17 + NIP-44 encryption
     * 7. Encode token for sharing (V4 CBOR + Bech32)
     *
     * @param request Voucher issuance parameters (amount, memo, expiry, etc.)
     * @return Result containing issued voucher and encoded token, or error
     * @throws cash.imani.voucher.domain.VoucherIssuanceException on issuance failure
     *
     * ## JVM Implementation
     * ```kotlin
     * override suspend fun issueVoucher(request: IssueVoucherRequest) =
     *     withContext(Dispatchers.IO) {
     *         runCatching {
     *             val javaResult = voucherService.issueAndBackup(request.toJava())
     *             javaResult.toKotlin()
     *         }
     *     }
     * ```
     *
     * ## Web Implementation
     * ```kotlin
     * override suspend fun issueVoucher(request: IssueVoucherRequest) =
     *     issueVoucherUseCase(request) // Delegate to existing use case
     * ```
     */
    suspend fun issueVoucher(request: IssueVoucherRequest): Result<IssueVoucherResult>

    /**
     * Redeems a voucher from its encoded token.
     *
     * Flow:
     * 1. Decode Cashu V4 token (CBOR + Bech32)
     * 2. Check proof states with mint (verify not spent)
     * 3. Verify issuer signature if voucher is known
     * 4. Import proofs to wallet
     * 5. Update voucher status to REDEEMED
     * 6. (JVM only) Publish redemption event to Nostr ledger
     *
     * @param token Cashu V4 token string (cashuA...)
     * @param voucherId Optional voucher ID if redeeming a known voucher
     * @return Result containing redemption details (amount, proofs, etc.), or error
     * @throws cash.imani.voucher.domain.VoucherRedemptionException on redemption failure
     *
     * ## JVM Implementation
     * ```kotlin
     * override suspend fun redeemVoucher(token: String, voucherId: String?) =
     *     withContext(Dispatchers.IO) {
     *         runCatching {
     *             val javaResult = voucherService.receive(token)
     *             javaResult.toKotlin()
     *         }
     *     }
     * ```
     *
     * ## Web Implementation
     * ```kotlin
     * override suspend fun redeemVoucher(token: String, voucherId: String?) =
     *     redeemVoucherUseCase(token, voucherId)
     * ```
     */
    suspend fun redeemVoucher(
        token: String,
        voucherId: String? = null,
    ): Result<RedeemVoucherResult>

    /**
     * Revokes a previously issued voucher.
     *
     * Publishes a revocation event to the Nostr ledger (NIP-33 parameterized replaceable event).
     * This prevents the voucher from being redeemed and marks it as REVOKED.
     *
     * Note: Revocation does NOT recover the proofs. The ecash is permanently burned.
     * Use this for emergency revocation (e.g., compromised voucher, fraudulent redemption attempt).
     *
     * @param voucherId ID of the voucher to revoke
     * @return Result indicating success or error
     * @throws cash.imani.voucher.domain.VoucherRevocationException on revocation failure
     *
     * ## JVM Implementation
     * ```kotlin
     * override suspend fun revokeVoucher(voucherId: String) =
     *     withContext(Dispatchers.IO) {
     *         runCatching {
     *             voucherService.revoke(voucherId)
     *         }
     *     }
     * ```
     *
     * ## Web Implementation
     * ```kotlin
     * override suspend fun revokeVoucher(voucherId: String) =
     *     revokeVoucherUseCase(voucherId) // Uses NostrVoucherClient
     * ```
     */
    suspend fun revokeVoucher(voucherId: String): Result<Unit>

    /**
     * Verifies a voucher's issuer signature.
     *
     * Uses Ed25519 signature verification (NIP-01) to validate that the voucher
     * was issued by the claimed identity and has not been tampered with.
     *
     * Verification checks:
     * 1. Issuer signature is valid (Schnorr/Ed25519)
     * 2. Voucher data matches signed message
     * 3. Issuer public key is valid Nostr npub
     *
     * @param voucher Voucher to verify
     * @return Result containing true if valid, false otherwise
     *
     * ## JVM Implementation
     * ```kotlin
     * override suspend fun verifyVoucher(voucher: StoredVoucher) =
     *     withContext(Dispatchers.IO) {
     *         runCatching {
     *             voucherService.verify(voucher.toJava())
     *         }
     *     }
     * ```
     *
     * ## Web Implementation
     * ```kotlin
     * override suspend fun verifyVoucher(voucher: StoredVoucher) =
     *     verifyVoucherUseCase(voucher) // Uses CryptoAdapter.schnorrVerify()
     * ```
     */
    suspend fun verifyVoucher(voucher: StoredVoucher): Result<Boolean>

    /**
     * Lists all vouchers in the wallet.
     *
     * Returns vouchers sorted by issuedAt timestamp (most recent first).
     * Includes vouchers in all states: ISSUED, DELIVERED, REDEEMED, REVOKED, EXPIRED.
     *
     * @return Result containing list of vouchers, or error
     *
     * ## JVM Implementation
     * ```kotlin
     * override suspend fun listVouchers() =
     *     withContext(Dispatchers.IO) {
     *         runCatching {
     *             voucherService.list().map { it.toKotlin() }
     *         }
     *     }
     * ```
     *
     * ## Web Implementation
     * ```kotlin
     * override suspend fun listVouchers() =
     *     voucherRepository.listVouchers() // From IndexedDB or Nostr cache
     * ```
     */
    suspend fun listVouchers(): Result<List<StoredVoucher>>

    /**
     * Queries vouchers by status.
     *
     * Filters vouchers by their current lifecycle status.
     *
     * @param status Status to filter by (ISSUED, DELIVERED, REDEEMED, etc.)
     * @return Result containing list of vouchers with specified status, or error
     *
     * ## JVM Implementation
     * ```kotlin
     * override suspend fun queryVouchersByStatus(status: VoucherStatus) =
     *     withContext(Dispatchers.IO) {
     *         runCatching {
     *             voucherService.queryByStatus(status.toJava()).map { it.toKotlin() }
     *         }
     *     }
     * ```
     *
     * ## Web Implementation
     * ```kotlin
     * override suspend fun queryVouchersByStatus(status: VoucherStatus) =
     *     voucherRepository.queryVouchersByStatus(status)
     * ```
     */
    suspend fun queryVouchersByStatus(status: cash.imani.voucher.domain.VoucherStatus): Result<List<StoredVoucher>>

    /**
     * Backs up all vouchers to Nostr relays using encrypted events.
     *
     * Uses NIP-17 (Private Direct Messages) + NIP-44 (Versioned Encryption) to securely
     * store voucher data on Nostr relays. Encrypted with user's identity key.
     *
     * Backup format:
     * - Kind: 30078 (NIP-33 parameterized replaceable event)
     * - Content: NIP-44 encrypted JSON of StoredVoucher
     * - Tags: ["d", voucherId], ["status", status], ["unit", unit]
     *
     * @return Result indicating success or error
     * @throws cash.imani.voucher.domain.BackupException on backup failure
     *
     * ## JVM Implementation
     * ```kotlin
     * override suspend fun backupToNostr() =
     *     withContext(Dispatchers.IO) {
     *         runCatching {
     *             sendService.backupVouchers(voucherService.list())
     *         }
     *     }
     * ```
     *
     * ## Web Implementation
     * ```kotlin
     * override suspend fun backupToNostr() =
     *     nostrVoucherRepository.syncToNostr() // Uses NostrVoucherClient
     * ```
     */
    suspend fun backupToNostr(): Result<Unit>

    /**
     * Restores vouchers from Nostr relays.
     *
     * Queries Nostr relays for encrypted voucher events (NIP-33 kind 30078),
     * decrypts them using NIP-44, and imports them into the local wallet.
     *
     * Query filters:
     * - Author: User's identity public key
     * - Kind: 30078 (voucher events)
     * - Since: Last backup timestamp (or epoch 0 for full restore)
     *
     * @return Result containing list of restored vouchers, or error
     * @throws cash.imani.voucher.domain.RestoreException on restore failure
     *
     * ## JVM Implementation
     * ```kotlin
     * override suspend fun restoreFromNostr() =
     *     withContext(Dispatchers.IO) {
     *         runCatching {
     *             voucherService.refreshStatus().map { it.toKotlin() }
     *         }
     *     }
     * ```
     *
     * ## Web Implementation
     * ```kotlin
     * override suspend fun restoreFromNostr() =
     *     nostrVoucherRepository.syncFromNostr() // Uses NostrVoucherClient
     * ```
     */
    suspend fun restoreFromNostr(): Result<List<StoredVoucher>>
}

/**
 * Factory function for creating platform-specific VoucherAdapter.
 *
 * **JVM Platform**: Returns JvmVoucherAdapter wrapping cashu-client Java libraries
 * **Web Platform**: Returns WebVoucherAdapter with full business logic implementation
 *
 * Implementation provided via expect/actual pattern.
 *
 * **Phase 2.4.1 Update**: Added dependencies for IssueVoucherUseCase logic.
 * **Phase 2.4.2 Update**: Removed RedeemVoucherUseCase dependency, all logic in adapter.
 * Web adapter no longer delegates to use cases but implements all logic directly.
 *
 * @param voucherRepository Repository for voucher storage
 * @param proofRepository Repository for proof management
 * @param mintApiClient HTTP client for Cashu mint API
 * @param identityRepository Repository for identity management
 * @param nostrClient Client for Nostr relay operations
 * @param cryptoAdapter Cryptographic adapter for signatures
 * @return Platform-specific VoucherAdapter implementation
 */
expect fun createVoucherAdapter(
    voucherRepository: cash.imani.voucher.repository.VoucherRepository,
    proofRepository: cash.imani.voucher.repository.ProofRepository,
    mintApiClient: cash.imani.voucher.network.MintApiClient,
    identityRepository: cash.imani.identity.repository.IdentityRepository,
    nostrClient: cash.imani.voucher.nostr.NostrVoucherClient,
    cryptoAdapter: cash.imani.identity.crypto.CryptoAdapter,
): VoucherAdapter
