package cash.imani.voucher.usecases

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.repository.IdentityRepository
import cash.imani.identity.util.toHex
import cash.imani.voucher.domain.StoredVoucher
import cash.imani.voucher.domain.VoucherIssuanceException
import cash.imani.voucher.domain.VoucherStatus
import cash.imani.voucher.encoding.TokenEncoder
import cash.imani.voucher.network.BlindedMessage
import cash.imani.voucher.network.MintApiClient
import cash.imani.voucher.repository.InsufficientBalanceException
import cash.imani.voucher.repository.ProofRepository
import cash.imani.voucher.repository.VoucherRepository
import kotlinx.datetime.Clock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlin.time.Duration.Companion.days

/**
 * Use case for issuing vouchers.
 *
 * Voucher issuance flow:
 * 1. Select proofs from wallet (FIFO coin selection)
 * 2. Create P2PK secret if recipient specified (NUT-11)
 * 3. Blind secrets and swap proofs with mint (NUT-03)
 * 4. Unblind signatures to get new proofs
 * 5. Sign voucher with issuer's identity key
 * 6. Store voucher locally
 * 7. Encode token for sharing (V4 CBOR + Bech32)
 *
 * @property voucherRepository Repository for voucher persistence
 * @property proofRepository Repository for proof management
 * @property mintApiClient HTTP client for Cashu mint API
 * @property cryptoAdapter Cryptographic operations adapter
 * @property identityRepository Repository for identity management
 */
class IssueVoucherUseCase(
    private val voucherRepository: VoucherRepository,
    private val proofRepository: ProofRepository,
    private val mintApiClient: MintApiClient,
    private val cryptoAdapter: CryptoAdapter,
    private val identityRepository: IdentityRepository,
) {
    /**
     * Issues a new voucher.
     *
     * @param request Voucher issuance parameters
     * @return Result containing issued voucher details or error
     * @throws VoucherIssuanceException if issuance fails
     */
    suspend operator fun invoke(request: IssueVoucherRequest): Result<IssueVoucherResult> =
        runCatching {
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
            // Phase 2: Simplified blinding (placeholder for full BDHKE implementation)
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
            // Phase 2: Simplified unblinding
            val newProofs =
                swapResponse.signatures.mapIndexed { index, blindSig ->
                    cash.imani.voucher.domain.Proof(
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
                    // Will be set after signing
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

            IssueVoucherResult(
                voucher = voucherWithToken,
                token = token,
                backedUp = false,
                message = "Voucher issued successfully: ${request.amount} ${request.unit}",
            )
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
     * @return Random 32-byte hex string
     */
    private suspend fun generateVoucherId(): String = cryptoAdapter.generateRandomBytes(16).toHex()
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
