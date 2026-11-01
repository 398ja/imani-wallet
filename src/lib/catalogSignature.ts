import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/hashes/utils'
import type { SignedCatalog } from '@imani/licence'

/**
 * Is this tier catalog signed by the licence seller (#407)?
 *
 * BIP-340 over sha256 of the exact body bytes, by the LICENCE SELLER's key (`VITE_LICENCE_SELLER_PUBKEY`),
 * the key subscription.imani.casa signs with. Not the gateway issuer key: that key signs every
 * stall's coupons, so anyone able to mint through the gateway could not sign a catalog with it, but
 * nor do we hold it to sign one. No seller given means no catalog verifies, and the device stays on
 * the bundled one: the safe direction.
 *
 * Its own module, pure (no store, no env), so the subscription service's tests can check the
 * catalog they publish with the wallet's own verifier without pulling the whole wallet in.
 * `entitlement.ts` re-exports it with the build's pinned seller as the default.
 */
export function catalogSignedBy(signed: SignedCatalog, sellerPublicKey: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(sellerPublicKey) || !/^[0-9a-f]{128}$/i.test(signed.signature)) return false
  try {
    return schnorr.verify(hexToBytes(signed.signature), sha256(new TextEncoder().encode(signed.body)), hexToBytes(sellerPublicKey))
  } catch {
    return false
  }
}
