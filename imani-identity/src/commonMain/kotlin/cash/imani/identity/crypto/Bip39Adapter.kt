package cash.imani.identity.crypto

/**
 * BIP39 mnemonic phrase utilities.
 *
 * Provides functions for:
 * - Generating mnemonic phrases from entropy
 * - Converting mnemonics to seed for key derivation
 * - Validating mnemonic checksums
 *
 * Implementation Strategy:
 * - **Web (jsMain)**: Uses @scure/bip39 library via JS interop
 * - **Android/iOS**: Will use platform-specific libraries in Phase 4/5
 */
interface Bip39Adapter {
    /**
     * Generates a BIP39 mnemonic phrase from entropy.
     *
     * @param entropyBytes 16 bytes (128 bits) for 12 words, or 32 bytes (256 bits) for 24 words
     * @return Space-separated mnemonic phrase (e.g., "abandon abandon ... about")
     * @throws IllegalArgumentException if entropy length is invalid
     */
    suspend fun entropyToMnemonic(entropyBytes: ByteArray): String

    /**
     * Converts a mnemonic phrase to a seed for key derivation.
     *
     * Implements BIP39 PBKDF2 key stretching with 2048 iterations.
     *
     * @param mnemonic Space-separated mnemonic phrase
     * @param passphrase Optional passphrase for additional security (default: empty)
     * @return 64-byte seed for BIP32 key derivation
     * @throws IllegalArgumentException if mnemonic is invalid
     */
    suspend fun mnemonicToSeed(
        mnemonic: String,
        passphrase: String = "",
    ): ByteArray

    /**
     * Validates a mnemonic phrase.
     *
     * Checks:
     * - Word count (12, 15, 18, 21, or 24 words)
     * - All words are in BIP39 wordlist
     * - Checksum is valid
     *
     * @param mnemonic Space-separated mnemonic phrase
     * @return true if valid, false otherwise
     */
    suspend fun validateMnemonic(mnemonic: String): Boolean

    /**
     * Derives a private key from a BIP39 seed using BIP32/BIP44 derivation.
     *
     * Default path for Nostr (NIP-06): m/44'/1237'/0'/0/0
     *
     * @param seed 64-byte seed from mnemonicToSeed
     * @param path BIP32 derivation path (default: Nostr standard)
     * @return 32-byte secp256k1 private key
     */
    suspend fun derivePrivateKey(
        seed: ByteArray,
        path: String = "m/44'/1237'/0'/0/0",
    ): ByteArray
}

/**
 * Factory function to create platform-specific Bip39Adapter implementation.
 */
expect fun createBip39Adapter(): Bip39Adapter
