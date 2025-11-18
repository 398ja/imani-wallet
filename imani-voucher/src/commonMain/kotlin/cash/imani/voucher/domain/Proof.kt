package cash.imani.voucher.domain

import kotlinx.serialization.Serializable

/**
 * Represents a Cashu proof - a cryptographic token proving ownership of value.
 *
 * Based on NUT-00: https://github.com/cashubtc/nuts/blob/main/00.md
 *
 * @property amount The denomination/amount of this proof in base units
 * @property secret The secret that unlocks this proof (may be structured for spending conditions)
 * @property C The unblinded signature (point on elliptic curve, hex-encoded)
 * @property id The keyset ID this proof was signed with
 */
@Serializable
data class Proof(
    val amount: Int,
    val secret: String,
    val C: String,
    val id: String // KeySet ID
) {
    /**
     * Computes the Y value (hash-to-curve of secret) used for proof state checking.
     */
    fun computeY(): String {
        // TODO: Implement hash-to-curve for secp256k1
        // return hashToCurve(secret).toHex()
        return "02${secret.take(62)}" // Placeholder
    }
}
