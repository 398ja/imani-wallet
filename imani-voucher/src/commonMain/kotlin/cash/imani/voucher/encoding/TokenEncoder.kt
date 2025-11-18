package cash.imani.voucher.encoding

import cash.imani.identity.util.Bech32
import cash.imani.voucher.domain.Proof
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.cbor.Cbor
import kotlinx.serialization.decodeFromByteArray
import kotlinx.serialization.encodeToByteArray

/**
 * Encoder/decoder for Cashu tokens (NUT-00).
 *
 * Cashu V4 tokens use:
 * - CBOR encoding for compact binary representation
 * - Bech32 encoding with "cashuA" prefix for text representation
 *
 * Token structure:
 * - mint: URL of the mint
 * - unit: Unit of account (e.g., "sat")
 * - proofs: List of proofs being transferred
 * - memo: Optional message/description
 *
 * Example encoded token:
 * cashuAeyJwcm9vZnMiOlt7ImFtb3VudCI6MSwiaWQiOiIwMGFkMjY4...
 *
 * Based on: https://github.com/cashubtc/nuts/blob/main/00.md
 */
@OptIn(ExperimentalSerializationApi::class)
object TokenEncoder {
    private val cbor = Cbor { ignoreUnknownKeys = true }

    /**
     * Encodes proofs into a Cashu V4 token string.
     *
     * @param proofs List of proofs to include in the token
     * @param mintUrl URL of the mint that issued the proofs
     * @param unit Unit of account (default: "sat")
     * @param memo Optional memo/message
     * @return Bech32-encoded token string starting with "cashuA"
     */
    fun encodeV4(
        proofs: List<Proof>,
        mintUrl: String,
        unit: String = "sat",
        memo: String? = null,
    ): String {
        val token =
            TokenV4(
                mint = mintUrl,
                unit = unit,
                proofs = proofs.map { TokenProof(it.amount, it.secret, it.C, it.id) },
                memo = memo,
            )

        // Encode to CBOR binary
        val cborBytes = cbor.encodeToByteArray(token)

        // Encode with Bech32
        return Bech32.encode("cashuA", cborBytes)
    }

    /**
     * Decodes a Cashu V4 token string into structured data.
     *
     * @param token Bech32-encoded token string
     * @return Decoded TokenV4 structure
     * @throws IllegalArgumentException if token format is invalid
     */
    fun decodeV4(token: String): TokenV4 {
        val (hrp, data) = Bech32.decode(token)
        require(hrp == "cashuA") { "Invalid token prefix: expected 'cashuA', got '$hrp'" }

        return cbor.decodeFromByteArray(data)
    }

    /**
     * Converts TokenV4 to a list of domain Proofs.
     */
    fun TokenV4.toProofs(): List<Proof> =
        proofs.map { tokenProof ->
            Proof(
                amount = tokenProof.amount,
                secret = tokenProof.secret,
                C = tokenProof.C,
                id = tokenProof.id,
            )
        }
}

/**
 * Cashu V4 token structure (NUT-00).
 *
 * @property mint URL of the mint
 * @property unit Unit of account (e.g., "sat" for satoshis)
 * @property proofs List of proofs in this token
 * @property memo Optional memo/message
 */
@Serializable
data class TokenV4(
    @SerialName("m") val mint: String,
    @SerialName("u") val unit: String,
    @SerialName("p") val proofs: List<TokenProof>,
    @SerialName("d") val memo: String? = null,
)

/**
 * Proof representation in V4 token (compact CBOR keys).
 *
 * @property amount Denomination/amount
 * @property secret Secret that unlocks the proof
 * @property C Unblinded signature (hex-encoded point)
 * @property id Keyset ID
 */
@Serializable
data class TokenProof(
    @SerialName("a") val amount: Int,
    @SerialName("s") val secret: String,
    @SerialName("c") val C: String,
    @SerialName("i") val id: String,
)
