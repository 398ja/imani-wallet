@file:JsModule("@scure/bip39")
@file:JsNonModule

package cash.imani.identity.crypto

import org.khronos.webgl.Uint8Array

/**
 * External declarations for @scure/bip39 library.
 *
 * See: https://github.com/paulmillr/scure-bip39
 */

external fun generateMnemonic(wordlist: Array<String>, strength: Int = definedExternally): String

external fun mnemonicToSeedSync(mnemonic: String, passphrase: String = definedExternally): Uint8Array

external fun validateMnemonic(mnemonic: String, wordlist: Array<String>): Boolean

external val wordlists: Wordlists

external interface Wordlists {
    val english: Array<String>
}
