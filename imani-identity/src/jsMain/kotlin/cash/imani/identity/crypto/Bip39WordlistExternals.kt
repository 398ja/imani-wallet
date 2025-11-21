@file:JsModule("@scure/bip39/wordlists/english")
@file:JsNonModule

package cash.imani.identity.crypto

/**
 * External declarations for @scure/bip39/wordlists/english module.
 *
 * The English wordlist for BIP39 mnemonic generation and validation.
 */
external object EnglishWordlist {
    val wordlist: Array<String>
}
