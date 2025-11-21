@file:JsModule("@noble/secp256k1")
@file:JsNonModule

package cash.imani.identity.crypto

import org.khronos.webgl.Uint8Array

/**
 * External declarations for @noble/secp256k1 library.
 *
 * See: https://github.com/paulmillr/noble-secp256k1
 */

external fun getPublicKey(
    privateKey: Uint8Array,
    compressed: Boolean = definedExternally,
): Uint8Array

external object schnorr {
    fun sign(
        message: Uint8Array,
        privateKey: Uint8Array,
    ): Uint8Array

    fun verify(
        signature: Uint8Array,
        message: Uint8Array,
        publicKey: Uint8Array,
    ): Boolean
}

external object etc {
    fun hexToBytes(hex: String): Uint8Array

    fun bytesToHex(bytes: Uint8Array): String
}
