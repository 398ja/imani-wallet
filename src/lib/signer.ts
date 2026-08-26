import { finalizeEvent, getPublicKey, nip19, nip44 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import type { EvictableSigner } from '@imani/nap-client-web'

/**
 * A signer that holds the customer's key in the page.
 *
 * Chosen over NIP-07 for one reason: receiving coupons requires NIP-44
 * decryption to unwrap NIP-17 gift wraps, and nap's signer contract is
 * sign-only (`EventSigner.signEvent`) — decryption is out of NAP's scope, it
 * being an authentication protocol. imani-apps' receive pipeline
 * (`DmPollService`) likewise takes a `recipientPrivkey`. A key-free signer
 * cannot serve either, so the key lives here, and nap owns its lifecycle.
 *
 * EvictableSigner is the contract that makes that safe: RFC §28.6 requires a
 * lock to actually zero key material rather than only flag session state.
 * `clearKey()` does that; `setKey()` restores it after a passphrase reunlock
 * against the WebCrypto keystore. Between lock and reunlock there is no key in
 * memory to steal.
 */
export interface WalletSigner extends EvictableSigner {
  /** Public key hex, available whether or not the key is currently held. */
  readonly pubkey: string
  /**
   * NIP-44 decrypt, for unwrapping gift wraps. Deliberately NOT part of nap's
   * SessionSigner — this is the wallet's own capability, sitting alongside the
   * nap contract rather than pretending to be part of it.
   */
  nip44Decrypt(peerPubkey: string, ciphertext: string): string
  /**
   * NIP-44 encrypt. Used to publish the merchant's own records to a relay
   * readable only by this key — pass `signer.pubkey` as the peer to encrypt to
   * yourself, which NIP-44 supports because the conversation key for (k, K) is
   * the same either way round.
   */
  nip44Encrypt(peerPubkey: string, plaintext: string): string
  /** The raw key, for handing to DmPollService. Throws while locked. */
  privkeyHex(): string
}

export class SessionLockedError extends Error {
  constructor() {
    super('The wallet is locked.')
    this.name = 'SessionLockedError'
  }
}

/**
 * @param privkeyHex the customer's secret key. Held only until `clearKey()`.
 */
export function createWalletSigner(privkeyHex: string): WalletSigner {
  // Captured once so the identity survives a lock: nap's identity guard
  // compares pubkeys, and a signer that forgot who it was on lock would look
  // like an account switch on unlock.
  const pubkey = getPublicKey(hexToBytes(privkeyHex))
  let key: Uint8Array | null = hexToBytes(privkeyHex)
  let hex: string | null = privkeyHex

  const require = (): Uint8Array => {
    if (!key) throw new SessionLockedError()
    return key
  }

  return {
    pubkey,

    signEvent: async (template) => finalizeEvent(template as never, require()),
    getNpub: () => nip19.npubEncode(pubkey),

    hasKey: () => key !== null,
    setKey(next: string) {
      if (getPublicKey(hexToBytes(next)) !== pubkey) {
        // nap requires the restored key to be the same identity. Letting a
        // different one back in would silently re-point an authenticated
        // session at another account.
        throw new Error('Refusing to restore a key for a different identity.')
      }
      key = hexToBytes(next)
      hex = next
    },
    clearKey() {
      // Zero before dropping the reference — the point of eviction is that the
      // bytes stop existing, not that we stop pointing at them.
      key?.fill(0)
      key = null
      hex = null
    },

    nip44Decrypt: (peerPubkey, ciphertext) =>
      nip44.decrypt(ciphertext, nip44.getConversationKey(require(), peerPubkey)),

    nip44Encrypt: (peerPubkey, plaintext) =>
      nip44.encrypt(plaintext, nip44.getConversationKey(require(), peerPubkey)),

    privkeyHex() {
      if (!hex) throw new SessionLockedError()
      return hex
    },
  } satisfies WalletSigner
}
