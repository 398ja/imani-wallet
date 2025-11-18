package cash.imani.identity.domain

import cash.imani.identity.util.Bech32
import cash.imani.identity.util.hexToBytes

/**
 * Extension functions for Identity domain model.
 */

/**
 * Converts the identity's public key to npub (Nostr public key) format.
 *
 * @return Bech32-encoded public key (npub1...)
 */
fun Identity.toNpub(): String {
    return Bech32.encodeNpub(publicKey.hexToBytes())
}

/**
 * Gets a shortened version of the npub for display.
 *
 * @param prefixLength Number of characters to show at start (default: 8)
 * @param suffixLength Number of characters to show at end (default: 8)
 * @return Shortened npub like "npub1abc...xyz"
 */
fun Identity.toShortNpub(
    prefixLength: Int = 8,
    suffixLength: Int = 8,
): String {
    val npub = toNpub()
    if (npub.length <= prefixLength + suffixLength + 3) {
        return npub
    }
    return "${npub.take(prefixLength)}...${npub.takeLast(suffixLength)}"
}
