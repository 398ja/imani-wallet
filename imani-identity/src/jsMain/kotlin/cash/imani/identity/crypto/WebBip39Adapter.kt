package cash.imani.identity.crypto

import org.khronos.webgl.Uint8Array

/**
 * Web implementation of Bip39Adapter using @scure/bip39 library.
 *
 * Provides BIP39 mnemonic operations via JavaScript interop.
 */
actual fun createBip39Adapter(): Bip39Adapter = WebBip39Adapter()

class WebBip39Adapter : Bip39Adapter {
    override suspend fun entropyToMnemonic(entropyBytes: ByteArray): String {
        try {
            // Debug: Check wordlist
            console.log("[WebBip39Adapter] wordlist type:", js("typeof wordlist"))
            console.log("[WebBip39Adapter] wordlist value:", wordlist)
            console.log("[WebBip39Adapter] wordlist length:", wordlist.asDynamic().length)
            console.log("[WebBip39Adapter] wordlist is array:", js("Array.isArray(wordlist)"))

            // Use @scure/bip39 via external declarations
            // Generate mnemonic with 128 bits (12 words)
            val mnemonic: String = generateMnemonic(wordlist, 128)
            return mnemonic
        } catch (e: Exception) {
            throw IllegalArgumentException("Failed to generate mnemonic from entropy", e)
        }
    }

    override suspend fun mnemonicToSeed(
        mnemonic: String,
        passphrase: String,
    ): ByteArray {
        try {
            // Use @scure/bip39's sync mnemonicToSeedSync
            val seedUint8Array = mnemonicToSeedSync(mnemonic, passphrase)

            // Convert Uint8Array to ByteArray
            return seedUint8Array.toByteArray()
        } catch (e: Exception) {
            throw IllegalArgumentException("Failed to convert mnemonic to seed", e)
        }
    }

    override suspend fun validateMnemonic(mnemonic: String): Boolean {
        return try {
            cash.imani.identity.crypto.validateMnemonic(mnemonic, wordlist)
        } catch (e: Exception) {
            false
        }
    }

    override suspend fun derivePrivateKey(
        seed: ByteArray,
        path: String,
    ): ByteArray {
        // TODO Phase 1.2: Implement BIP32 key derivation
        // For now, use simple HMAC-SHA512 derivation (NOT BIP32 compliant)
        // This will be replaced with proper BIP32 in Phase 1.2 when adding @scure/bip32

        // Temporary: Use first 32 bytes of seed as private key
        // WARNING: This is NOT BIP32 compliant - for Phase 1 MVP only
        if (seed.size < 32) {
            throw IllegalArgumentException("Seed must be at least 32 bytes")
        }
        return seed.copyOfRange(0, 32)
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
