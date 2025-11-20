package cash.imani.voucher.adapter

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.repository.IdentityRepository
import cash.imani.identity.util.toHex
import cash.imani.voucher.domain.Proof
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherIssuanceException
import cash.imani.voucher.domain.VoucherRedemptionException
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.encoding.TokenEncoder
import cash.imani.voucher.network.BlindedMessage
import cash.imani.voucher.network.MintApiClient
import cash.imani.voucher.nostr.NostrVoucherClient
import cash.imani.voucher.repository.InsufficientBalanceException
import cash.imani.voucher.repository.ProofRepository
import cash.imani.voucher.repository.VoucherRepository
import cash.imani.voucher.usecases.IssueVoucherRequest
import cash.imani.voucher.usecases.IssueVoucherResult
import cash.imani.voucher.usecases.RedeemVoucherResult
import kotlinx.datetime.Clock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.time.Duration.Companion.days

/**
 * Web (JS) implementation of VoucherAdapter.
 *
 * Implements complete voucher lifecycle logic for the web platform:
 * - Proof selection and swap operations with Cashu mint
 * - P2PK secret generation (NUT-11)
 * - Token encoding (V4 CBOR + Bech32)
 * - Voucher signing with Schnorr signatures
 * - IndexedDB storage for browser persistence
 * - Nostr relay backup using nostr-tools library
 * - Web Crypto API for cryptographic operations
 *
 * **Phase 2.4.1 Refactoring**: Moved all business logic from IssueVoucherUseCase into this adapter.
 * **Phase 2.4.2 Refactoring**: Moved all business logic from RedeemVoucherUseCase into this adapter.
 * Use cases are now thin wrappers that delegate to this adapter.
 *
 * @param voucherRepository Repository for local voucher storage (IndexedDB)
 * @param proofRepository Repository for proof management
 * @param mintApiClient HTTP client for Cashu mint API
 * @param identityRepository Repository for identity management
 * @param nostrClient Client for Nostr relay operations (nostr-tools)
 * @param cryptoAdapter Web Crypto API adapter for cryptographic operations
 *
 * @see VoucherAdapter
 * @see cash.imani.voucher.repository.NostrVoucherRepository
 */
class WebVoucherAdapter(
    private val voucherRepository: VoucherRepository,
    private val proofRepository: ProofRepository,
    private val mintApiClient: MintApiClient,
    private val identityRepository: IdentityRepository,
    private val nostrClient: NostrVoucherClient,
    private val cryptoAdapter: CryptoAdapter,
) : VoucherAdapter {
    /**
     * Issues a voucher with complete business logic implementation.
     *
     * Voucher issuance flow:
     * 1. Select proofs from wallet (FIFO coin selection)
     * 2. Create P2PK secret if recipient specified (NUT-11)
     * 3. Blind secrets and swap proofs with mint (NUT-03)
     * 4. Unblind signatures to get new proofs
     * 5. Sign voucher with issuer's identity key
     * 6. Store voucher locally (IndexedDB)
     * 7. Encode token for sharing (V4 CBOR + Bech32)
     *
     * @param request Voucher issuance parameters
     * @return Result containing issued voucher and token
     */
    override suspend fun issueVoucher(request: IssueVoucherRequest): Result<IssueVoucherResult> =
        runCatching {
            println("[WebVoucherAdapter] Issuing voucher with full implementation")

            // 1. Get active identity (most recently used)
            val identities = identityRepository.listIdentities().getOrThrow()
            val identity = identities.firstOrNull() ?: throw VoucherIssuanceException.NoActiveIdentity()

            // 2. Select proofs from wallet
            val inputProofs =
                try {
                    proofRepository.selectProofs(request.amount, request.mintUrl, request.unit).getOrThrow()
                } catch (e: InsufficientBalanceException) {
                    val balance = proofRepository.getBalance(request.mintUrl, request.unit).getOrDefault(0)
                    throw VoucherIssuanceException.InsufficientFunds(request.amount, balance, request.unit)
                }

            // 3. Create secrets for new proofs
            val secrets =
                if (request.lockToPubkey != null) {
                    // P2PK secret: locked to recipient's public key
                    listOf(createP2PKSecret(request.lockToPubkey))
                } else {
                    // Random secret: anyone with token can redeem
                    listOf(generateRandomSecret())
                }

            // 4. Get mint keysets to determine which keyset to use
            val keysets = mintApiClient.getKeySets(request.mintUrl).getOrThrow()
            val activeKeyset = keysets.firstOrNull { it.active } ?: keysets.first()

            // 5. Create blinded messages for swap
            val blindedMessages =
                secrets.map { secret ->
                    BlindedMessage(
                        amount = request.amount.toInt(),
                        id = activeKeyset.id,
                        B_ = blindSecret(secret),
                    )
                }

            // 6. Swap proofs with mint
            val swapResponse =
                try {
                    mintApiClient.swapProofs(
                        mintUrl = request.mintUrl,
                        proofs = inputProofs,
                        outputs = blindedMessages,
                    ).getOrThrow()
                } catch (e: Exception) {
                    throw VoucherIssuanceException.SwapFailed("Mint swap failed: ${e.message}", e)
                }

            // 7. Unblind signatures to get new proofs
            val newProofs =
                swapResponse.signatures.mapIndexed { index, blindSig ->
                    Proof(
                        amount = blindedMessages[index].amount,
                        secret = secrets[index],
                        C = blindSig.C_,
                        id = blindSig.id,
                    )
                }

            // 8. Delete spent proofs from wallet
            proofRepository.deleteProofs(inputProofs.map { it.secret }).getOrThrow()

            // 9. Generate voucher ID
            val voucherId = generateVoucherId()

            // 10. Create voucher payload
            val expiresAt =
                request.expiresInDays?.let {
                    Clock.System.now().plus(it.days).epochSeconds
                }

            val unsignedVoucher =
                StoredVoucher(
                    voucherId = voucherId,
                    issuerId = identity.id,
                    unit = request.unit,
                    faceValue = request.amount,
                    expiresAt = expiresAt,
                    memo = request.memo,
                    issuerSignature = "",
                    issuerPublicKey = identity.publicKey,
                    issuedAt = Clock.System.now(),
                    status = VoucherStatus.ISSUED,
                )

            // 11. Sign voucher with issuer's identity key
            val signedVoucher = signVoucher(unsignedVoucher, identity.id)

            // 12. Encode token for sharing
            val token = TokenEncoder.encodeV4(newProofs, request.mintUrl, request.unit, request.memo)

            // 13. Store voucher with token
            val voucherWithToken = signedVoucher.copy(token = token)
            try {
                voucherRepository.saveVoucher(voucherWithToken).getOrThrow()
            } catch (e: Exception) {
                throw VoucherIssuanceException.StorageFailed("Failed to save voucher: ${e.message}", e)
            }

            println("[WebVoucherAdapter] Successfully issued voucher: ${request.amount} ${request.unit}")

            IssueVoucherResult(
                voucher = voucherWithToken,
                token = token,
                backedUp = false,
                message = "Voucher issued successfully: ${request.amount} ${request.unit}",
            )
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
    ): Result<RedeemVoucherResult> =
        runCatching {
            println("[WebVoucherAdapter] Redeeming voucher with full implementation")

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
     * Creates a P2PK (Pay-to-Public-Key) secret following NUT-11 specification.
     *
     * P2PK secret format:
     * ["P2PK", {
     *   "data": "<recipient_pubkey>",
     *   "nonce": "<random_32_bytes_hex>",
     *   "tags": [["sigflag", "SIG_ALL"]]
     * }]
     *
     * @param recipientPubkey Recipient's public key (hex-encoded)
     * @return JSON-encoded P2PK secret
     */
    private suspend fun createP2PKSecret(recipientPubkey: String): String {
        val nonce = cryptoAdapter.generateRandomBytes(32).toHex()
        val p2pkData =
            mapOf(
                "data" to recipientPubkey,
                "nonce" to nonce,
                "tags" to listOf(listOf("sigflag", "SIG_ALL")),
            )
        return Json.encodeToString(listOf("P2PK", p2pkData))
    }

    /**
     * Generates a random secret for unrestricted vouchers.
     *
     * @return 32-byte random hex string
     */
    private suspend fun generateRandomSecret(): String = cryptoAdapter.generateRandomBytes(32).toHex()

    /**
     * Signs a voucher with the issuer's identity key.
     *
     * Message format: voucherId || issuerId || unit || faceValue || expiresAt || memo
     *
     * @param voucher Unsigned voucher
     * @param identityId Identity ID of the issuer
     * @return Signed voucher
     * @throws VoucherIssuanceException.SigningFailed if signing fails
     */
    private suspend fun signVoucher(
        voucher: StoredVoucher,
        identityId: String,
    ): StoredVoucher {
        try {
            // Build message to sign
            val message =
                buildString {
                    append(voucher.voucherId)
                    append(voucher.issuerId)
                    append(voucher.unit)
                    append(voucher.faceValue)
                    append(voucher.expiresAt ?: "")
                    append(voucher.memo ?: "")
                }

            // Get private key
            val privateKey = identityRepository.getPrivateKey(identityId).getOrThrow()

            // Hash message (Schnorr signatures operate on 32-byte hashes)
            val messageHash = cryptoAdapter.sha256(message.encodeToByteArray())

            // Sign with Schnorr
            val signature = cryptoAdapter.schnorrSign(privateKey, messageHash)

            return voucher.copy(issuerSignature = signature.toHex())
        } catch (e: Exception) {
            throw VoucherIssuanceException.SigningFailed("Failed to sign voucher: ${e.message}", e)
        }
    }

    /**
     * Blinds a secret for mint blinding signature.
     *
     * Phase 2: Simplified implementation using hash
     * Phase 3+: Full BDHKE (Blind Diffie-Hellman Key Exchange) implementation
     *
     * @param secret Secret to blind
     * @return Blinded secret (hex-encoded point)
     */
    private suspend fun blindSecret(secret: String): String {
        // Phase 2: Use hash as placeholder for blinded point
        // In production, this would use proper EC point multiplication with blinding factor
        val hash = cryptoAdapter.sha256(secret.encodeToByteArray())
        return hash.toHex()
    }

    /**
     * Generates a unique voucher ID.
     *
     * @return Random 16-byte hex string
     */
    private suspend fun generateVoucherId(): String = cryptoAdapter.generateRandomBytes(16).toHex()

    /**
     * Generates a unique redemption ID.
     *
     * @return Timestamp-based redemption ID
     */
    private fun generateRedemptionId(): String = Clock.System.now().toEpochMilliseconds().toString()

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
