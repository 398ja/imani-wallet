package cash.imani.identity.crypto

/**
 * External declarations for @scure/bip39/wordlists/english module.
 *
 * The English wordlist for BIP39 mnemonic generation and validation.
 *
 * Import the entire module and access wordlist property to avoid
 * Kotlin/JS module loading issues with named exports.
 */
@JsModule("@scure/bip39/wordlists/english")
@JsNonModule
external object EnglishWordlistModule {
    val wordlist: dynamic
}
