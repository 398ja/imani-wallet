// @file:JsModule("@scure/bip39")
// @file:JsNonModule

package cash.imani.identity.crypto

/**
 * External declarations for @scure/bip39 library.
 *
 * PHASE 1 NOTE: BIP39 functionality disabled for Phase 1.
 * Nostr identities only need secp256k1 keypairs (nsec/npub), not mnemonics.
 * BIP39 will be re-enabled in Phase 2 for wallet functionality.
 *
 * Commented out to avoid module loading issues during development.
 *
 * See: https://github.com/paulmillr/scure-bip39
 */

// external fun generateMnemonic(
//     wordlist: dynamic,
//     strength: Int = definedExternally,
// ): String
//
// external fun mnemonicToSeedSync(
//     mnemonic: String,
//     passphrase: String = definedExternally,
// ): Uint8Array
//
// external fun validateMnemonic(
//     mnemonic: String,
//     wordlist: dynamic,
// ): Boolean
