package cash.imani.voucher.network

import cash.imani.identity.crypto.CryptoAdapter
import cash.imani.identity.util.toHex
import cash.imani.voucher.domain.Proof
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.contentType

/**
 * HTTP client for Cashu Mint API.
 *
 * Implements the Cashu protocol for interacting with mints:
 * - Fetching mint information and keysets
 * - Swapping proofs (spending and receiving new ones)
 * - Checking proof states
 * - Creating and checking Lightning payment quotes
 *
 * Based on Cashu NUTs specifications:
 * - NUT-01: Mint public keys
 * - NUT-02: Keysets
 * - NUT-03: Swap
 * - NUT-04: Minting tokens (Lightning)
 * - NUT-06: Mint info
 * - NUT-07: Proof state check
 *
 * @property httpClient Ktor HTTP client configured for JSON
 * @property cryptoAdapter Crypto adapter for hashing operations
 */
open class MintApiClient(
    private val httpClient: HttpClient,
    private val cryptoAdapter: CryptoAdapter,
) {
    /**
     * Fetches mint information (NUT-06).
     *
     * @param mintUrl Base URL of the mint (e.g., "https://mint.example.com")
     * @return Result containing MintInfo or error
     */
    suspend fun getInfo(mintUrl: String): Result<MintInfo> =
        runCatching {
            val cleanUrl = mintUrl.trimEnd('/')
            httpClient.get("$cleanUrl/v1/info").body()
        }

    /**
     * Fetches available keysets from the mint (NUT-02).
     *
     * Keysets contain the mint's public keys used for blind signatures.
     * Each keyset has a unique ID and is associated with a unit of account.
     *
     * @param mintUrl Base URL of the mint
     * @return Result containing list of KeySets or error
     */
    suspend fun getKeySets(mintUrl: String): Result<List<KeySet>> =
        runCatching {
            val cleanUrl = mintUrl.trimEnd('/')
            val response: KeySetsResponse = httpClient.get("$cleanUrl/v1/keys").body()
            response.keysets
        }

    /**
     * Swaps proofs for new ones (NUT-03).
     *
     * This is the core operation for spending in Cashu:
     * - Provide proofs to be spent (inputs)
     * - Provide blinded messages for new proofs (outputs)
     * - Mint validates inputs and signs outputs
     * - Client unblinds signatures to get new proofs
     *
     * @param mintUrl Base URL of the mint
     * @param proofs List of proofs to spend (inputs)
     * @param outputs List of blinded messages for new proofs
     * @return Result containing blind signatures or error
     */
    suspend fun swapProofs(
        mintUrl: String,
        proofs: List<Proof>,
        outputs: List<BlindedMessage>,
    ): Result<SwapResponse> =
        runCatching {
            val cleanUrl = mintUrl.trimEnd('/')
            httpClient.post("$cleanUrl/v1/swap") {
                contentType(ContentType.Application.Json)
                setBody(SwapRequest(proofs, outputs))
            }.body()
        }

    /**
     * Checks the state of proofs (NUT-07).
     *
     * Allows checking whether proofs have been spent without revealing the secret.
     * Uses Y = hash-to-curve(secret) for privacy.
     *
     * States:
     * - UNSPENT: Proof has not been spent
     * - PENDING: Proof is currently being spent (transaction in progress)
     * - SPENT: Proof has been spent
     *
     * @param mintUrl Base URL of the mint
     * @param secrets List of proof secrets to check
     * @return Result containing proof states or error
     */
    suspend fun checkProofStates(
        mintUrl: String,
        secrets: List<String>,
    ): Result<ProofStateResponse> =
        runCatching {
            val cleanUrl = mintUrl.trimEnd('/')

            // Compute Y values: Y = SHA-256(secret)
            // Note: In full Cashu implementation, this should be hash-to-curve
            // For Phase 2 MVP, we use SHA-256 as placeholder
            val yValues =
                secrets.map { secret ->
                    cryptoAdapter.sha256(secret.encodeToByteArray()).toHex()
                }

            httpClient.post("$cleanUrl/v1/checkstate") {
                contentType(ContentType.Application.Json)
                setBody(CheckStateRequest(yValues))
            }.body()
        }

    /**
     * Creates a mint quote for Lightning payment (NUT-04).
     *
     * This generates a Lightning invoice that customers can pay to receive Cashu proofs.
     * The mint returns a quote ID and BOLT11 invoice.
     *
     * Flow:
     * 1. Client requests quote with amount
     * 2. Mint generates Lightning invoice
     * 3. Customer pays invoice
     * 4. Client polls for payment confirmation
     * 5. Client mints tokens using quote ID
     *
     * @param mintUrl Base URL of the mint
     * @param amount Amount to mint in specified unit
     * @param unit Unit of account (e.g., "sat")
     * @return Result containing mint quote with invoice or error
     */
    open suspend fun getMintQuote(
        mintUrl: String,
        amount: Int,
        unit: String,
    ): Result<MintQuoteResponse> =
        runCatching {
            val cleanUrl = mintUrl.trimEnd('/')
            httpClient.post("$cleanUrl/v1/mint/quote/bolt11") {
                contentType(ContentType.Application.Json)
                setBody(MintQuoteRequest(amount, unit))
            }.body()
        }

    /**
     * Checks the payment status of a mint quote (NUT-04).
     *
     * Polls the mint to check if the Lightning invoice has been paid.
     * Once paid, the client can mint tokens using POST /v1/mint/bolt11.
     *
     * @param mintUrl Base URL of the mint
     * @param quoteId Quote ID from getMintQuote
     * @return Result containing updated quote status or error
     */
    open suspend fun checkMintQuote(
        mintUrl: String,
        quoteId: String,
    ): Result<MintQuoteResponse> =
        runCatching {
            val cleanUrl = mintUrl.trimEnd('/')
            httpClient.get("$cleanUrl/v1/mint/quote/bolt11/$quoteId").body()
        }
}
