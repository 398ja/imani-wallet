import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from './bytes'
import { tagged, xOnly } from './format'

/**
 * Receipt signing goes through this interface so the wallet can back it with whatever holds the
 * key. Mirrors Java `ReceiptKey`.
 *
 * A signer MUST produce a BIP-340 signature over `tagged(tag, message)` (a 32-byte digest) by
 * the x-only key in `publicKey`. Nostr event signers (NIP-07 `signEvent`, NIP-46 `sign_event`)
 * cannot do that: they only sign an event id they compute themselves, so a receipt signer needs
 * the raw key (`localReceiptSigner` over `WalletSigner.withPrivkey`) or a remote signer that
 * gains a sign-digest method.
 */
export interface ReceiptSigner {
  /** x-only public key, lowercase hex. */
  readonly publicKey: string
  /** BIP-340 signature (64 bytes, hex) of `tagged(tag, message)`. */
  sign(tag: string, message: Uint8Array): string | Promise<string>
}

/** Signs `tagged(tag, bytes)` with a raw secret key. Fresh random aux, as Java does. */
export function signTagged(tag: string, bytes: Uint8Array, secretKey: Uint8Array): string {
  return bytesToHex(schnorr.sign(tagged(tag, bytes), secretKey))
}

/** Java `ReceiptSigner.verify`: false for any malformed input, never throws. */
export function verifyTagged(tag: string, bytes: Uint8Array, key: string | null | undefined, signatureHex: string | null | undefined): boolean {
  if (key == null || signatureHex == null) return false
  try {
    const sig = hexToBytes(signatureHex)
    if (sig.length !== 64) return false
    return schnorr.verify(sig, tagged(tag, bytes), hexToBytes(xOnly(key)))
  } catch {
    return false
  }
}

export function publicKeyOf(secretKey: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(secretKey))
}

/**
 * A signer over a key held in the page. `withKey` lends the key for one call and may wipe its
 * copy afterwards, which matches the wallet's `WalletSigner.withPrivkey`.
 */
export function localReceiptSigner(publicKey: string, withKey: <T>(use: (key: Uint8Array) => T) => T): ReceiptSigner {
  const pub = xOnly(publicKey)
  return {
    publicKey: pub,
    sign: (tag, message) => withKey((key) => signTagged(tag, message, key)),
  }
}

/** A signer over a raw secret key (tests, per-receipt keys). The array is copied. */
export function secretKeySigner(secretKey: Uint8Array): ReceiptSigner {
  const k = Uint8Array.from(secretKey)
  return localReceiptSigner(publicKeyOf(k), (use) => use(k))
}
