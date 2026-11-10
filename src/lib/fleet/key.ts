import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools'

import { wrapMessage } from '../giftWrap'
import type { SignedNostrEvent, SnapshotSigner, UnsignedEvent } from '../snapshot/types'

/**
 * The per-install fleet key (#591 contract C2).
 *
 *   fleet_sk = HMAC-SHA256(key = wallet_sk, msg = "imani-fleet-key-v1" || install_nonce)
 *
 * It is the fleet snapshot's ONLY identity (C1): it signs the NIP-98 requests, the Blossom auth
 * events and the manifest, and seals the handoff DM, so support never learns the wallet pubkey.
 *
 * Neither key is ever stored. Each use borrows the wallet key through `withPrivkey` (which wipes
 * its copy), derives the fleet key, uses it, and zeroes it. A locked wallet cannot derive it, so a
 * locked wallet cannot heartbeat. A signer that cannot lend its key (a remote signer) cannot
 * derive it either, and the feature is not offered (`canLendKey`).
 *
 * Opting out deletes the nonce, so a later opt-in gives a new key that cannot be linked to the old.
 */
export const FLEET_KEY_INFO = 'imani-fleet-key-v1'

export class FleetKeyError extends Error {
  constructor(reason: string) {
    super(`The fleet key could not be made (${reason}).`)
    this.name = 'FleetKeyError'
  }
}

/** Just the part of the wallet signer the fleet key needs. */
export interface KeyLender {
  withPrivkey<T>(borrow: (key: Uint8Array) => T): T
}

type Mac = (key: Uint8Array, msg: Uint8Array) => Uint8Array
const defaultMac: Mac = (key, msg) => hmac(sha256, key, msg)

/** The fleet secret key. The caller zeroes it. `mac` is a test seam for the invalid-scalar case. */
export function deriveFleetKey(walletSk: Uint8Array, installNonce: Uint8Array, mac: Mac = defaultMac): Uint8Array {
  if (installNonce.length !== 32) throw new FleetKeyError('nonce')
  if (walletSk.length !== 32) throw new FleetKeyError('wallet key')
  const info = new TextEncoder().encode(FLEET_KEY_INFO)
  const msg = new Uint8Array(info.length + 32)
  msg.set(info)
  msg.set(installNonce, info.length)
  const out = mac(walletSk, msg)
  msg.fill(0)
  // Zero or >= n is not a key. Never reduced or retried: that would be a different derivation.
  if (out.length !== 32 || !secp256k1.utils.isValidSecretKey(out)) {
    out.fill(0)
    throw new FleetKeyError('invalid scalar')
  }
  return out
}

/** Whether this signer can lend its raw key. False for a remote signer: fleet is then not offered. */
export function canLendKey(lender: KeyLender): boolean {
  try {
    return lender.withPrivkey((k) => k instanceof Uint8Array && k.length === 32)
  } catch {
    return false
  }
}

/** A SnapshotSigner over the fleet key, with NIP-17 wrapping. Holds the nonce as hex, no key bytes. */
export interface FleetSigner extends SnapshotSigner {
  /** NIP-17 gift wrap to `recipient`, sealed by the fleet key. */
  wrap(recipient: string, content: string): Event
}

export function fleetSigner(lender: KeyLender, installNonce: Uint8Array | string): FleetSigner {
  const nonceHex = typeof installNonce === 'string' ? installNonce : bytesToHex(installNonce)
  const use = <T,>(f: (fleetSk: Uint8Array) => T): T =>
    lender.withPrivkey((walletSk) => {
      const nonce = hexToBytes(nonceHex)
      const fk = deriveFleetKey(walletSk, nonce)
      nonce.fill(0)
      try {
        return f(fk)
      } finally {
        fk.fill(0)
      }
    })
  const pubkey = use((fk) => getPublicKey(fk))
  return {
    pubkey,
    signEvent: async (t: UnsignedEvent) => use((fk) => finalizeEvent({ ...t, tags: t.tags.map((x) => [...x]) }, fk)) as SignedNostrEvent,
    wrap: (recipient, content) => use((fk) => wrapMessage(fk, recipient, content)),
  }
}
