package cash.imani.identity.crypto

import org.khronos.webgl.Uint8Array

/**
 * Web implementation of Bip39Adapter using @scure/bip39 library.
 *
 * PHASE 1 NOTE: BIP39 functionality disabled for Phase 1.
 * Nostr identities only need secp256k1 keypairs (nsec/npub), not mnemonics.
 * BIP39 will be re-enabled in Phase 2 for wallet functionality.
 *
 * All methods throw UnsupportedOperationException until Phase 2.
 */
actual fun createBip39Adapter(): Bip39Adapter = WebBip39Adapter()

class WebBip39Adapter : Bip39Adapter {
    override suspend fun entropyToMnemonic(entropyBytes: ByteArray): String {
        throw UnsupportedOperationException(
            "BIP39 mnemonic generation is not available in Phase 1. " +
                "Nostr identities only require secp256k1 keypairs (nsec/npub). " +
                "BIP39 will be enabled in Phase 2 for wallet functionality.",
        )
    }

    override suspend fun mnemonicToSeed(
        mnemonic: String,
        passphrase: String,
    ): ByteArray {
        throw UnsupportedOperationException(
            "BIP39 mnemonic-to-seed conversion is not available in Phase 1. " +
                "Nostr identities only require secp256k1 keypairs (nsec/npub). " +
                "BIP39 will be enabled in Phase 2 for wallet functionality.",
        )
    }

    override suspend fun validateMnemonic(mnemonic: String): Boolean {
        throw UnsupportedOperationException(
            "BIP39 mnemonic validation is not available in Phase 1. " +
                "Nostr identities only require secp256k1 keypairs (nsec/npub). " +
                "BIP39 will be enabled in Phase 2 for wallet functionality.",
        )
    }

    override suspend fun derivePrivateKey(
        seed: ByteArray,
        path: String,
    ): ByteArray {
        throw UnsupportedOperationException(
            "BIP32 key derivation is not available in Phase 1. " +
                "Nostr identities only require secp256k1 keypairs (nsec/npub). " +
                "BIP32 will be enabled in Phase 2 for wallet functionality.",
        )
    }

    /**
     * Helper to convert Kotlin ByteArray to JavaScript Uint8Array.
     */
    private fun ByteArray.toUint8Array(): Uint8Array {
        val uint8Array = Uint8Array(this.size)
        for (i in this.indices) {
            uint8Array.asDynamic()[i] = this[i]
        }
        return uint8Array
    }

    /**
     * Helper to convert JavaScript Uint8Array to Kotlin ByteArray.
     */
    private fun Uint8Array.toByteArray(): ByteArray {
        return ByteArray(this.length) { i -> this.asDynamic()[i].unsafeCast<Byte>() }
    }
}
