import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

import { getSigner } from './nap'
import { proofSecrets } from './voucherToken'

/**
 * Signing the NUT-11 witness that unlocks a coupon locked to this wallet.
 *
 * **Why the customer signs and the gateway does not.** A coupon locked to your
 * key is spendable only by whoever can sign for that key. If the gateway could
 * produce that signature it would hold your money, however carefully it stored
 * things — which is the whole finding behind issue #58. So the signature is
 * made here, in the page, with the key that never leaves it, and only the
 * signature crosses the wire.
 *
 * **What is signed.** Taken from the mint's own verifier rather than the NUT-11
 * prose, because two details there fail in misleading ways:
 *
 * - BIP-340 signs `sha256(secret)`, not the secret bytes. Signing the raw
 *   message produces a signature that verifies against nothing, and the mint
 *   reports it as a missing signature rather than a malformed one.
 * - The lock in `data` is a 33-byte compressed key, while BIP-340 verifies
 *   against the 32-byte x-only form. The mint strips the `02`/`03` parity
 *   prefix before checking, so a signature made for the compressed form is not
 *   rejected loudly — it simply counts as no valid signature at all.
 *
 * Both are pinned by tests on the Java side (`P2pkWitnessSignerTest`) and here,
 * because the two implementations have to agree byte for byte and nothing else
 * would catch a drift.
 */

/** A NUT-10 secret is a JSON array whose first element names the kind. */
type Nut10Kind = 'P2PK' | 'P2PK_VOUCHER' | 'VOUCHER' | string

/**
 * Whether this secret carries a spending condition the mint will enforce.
 *
 * Matched on the declared kind, which is what the mint dispatches on. A plain
 * `VOUCHER` and a bearer secret are not locked and need no signature; asking
 * for one would be work the customer never has to authorise.
 */
export function isLockedSecret(secret: string): boolean {
  return secret.startsWith('["P2PK"') || secret.startsWith('["P2PK_VOUCHER"')
}

/**
 * The public key a secret is locked to, or null when it is not locked.
 *
 * Returned in the compressed form the secret carries. Callers comparing it to
 * a wallet's own nostr pubkey — which is x-only — must compare x-only to
 * x-only; `xOnly` below is the way to get there from either shape.
 */
export function lockedToPubkey(secret: string): string | null {
  if (!isLockedSecret(secret)) return null
  try {
    const parsed = JSON.parse(secret) as [Nut10Kind, { data?: unknown }]
    const data = parsed[1]?.data
    return typeof data === 'string' && data.length > 0 ? data : null
  } catch {
    // A secret we cannot parse is one we cannot sign for. Saying so plainly
    // beats guessing, since the mint is the thing that will refuse it.
    return null
  }
}

/** The x-only form the mint verifies against. Idempotent, so safe on either shape. */
export function xOnly(pubkeyHex: string): string {
  const normalised = pubkeyHex.startsWith('0x') ? pubkeyHex.slice(2) : pubkeyHex
  return normalised.length === 66 ? normalised.slice(2) : normalised
}

/**
 * Signs one NUT-10 secret with the wallet's key.
 *
 * Throws while the wallet is locked, because the key is genuinely absent then
 * — `signer.ts` zeroes it rather than merely flagging a state, so there is
 * nothing to sign with until the customer unlocks.
 */
export function signWitness(nut10Secret: string): string {
  const digest = sha256(utf8ToBytes(nut10Secret))
  const signature = schnorr.sign(digest, hexToBytes(getSigner().privkeyHex()))
  return bytesToHex(signature)
}

/**
 * Builds the witness map a spend request carries, keyed by the secret each
 * signature covers.
 *
 * Keyed by secret rather than by position because the gateway's wallet selects
 * and splits proofs internally after we have signed, so any index computed here
 * would not survive that. The secret is the one thing both sides agree on.
 *
 * Only locked secrets are signed. A wallet holding nothing but bearer coupons
 * produces an empty map, and the caller then sends no header at all — an
 * ordinary spend is unchanged by any of this.
 *
 * Secrets locked to a key that is not ours are skipped rather than signed with
 * the wrong key: a signature that cannot satisfy the condition is a wasted
 * signature, and including it would make a spend look authorised when it is
 * not.
 */
export function buildWitnesses(secrets: readonly string[]): Record<string, string[]> {
  const signer = getSigner()
  const ourKey = xOnly(signer.pubkey)
  const witnesses: Record<string, string[]> = {}

  for (const secret of secrets) {
    const lock = lockedToPubkey(secret)
    if (!lock) continue
    if (xOnly(lock) !== ourKey) continue
    witnesses[secret] = [signWitness(secret)]
  }

  return witnesses
}

/**
 * The request header carrying the witnesses, or null when there is nothing to
 * sign.
 *
 * Null rather than `{}` so the caller omits the header entirely on an ordinary
 * spend, which keeps the wire identical to what it was before locked coupons
 * existed.
 */
export function witnessHeader(secrets: readonly string[]): string | null {
  const witnesses = buildWitnesses(secrets)
  return Object.keys(witnesses).length === 0 ? null : JSON.stringify(witnesses)
}

/**
 * The proof secrets carried by an encoded token.
 *
 * Delegates to `voucherToken.proofSecrets`, which is the app's own TokenV4
 * reader, rather than decoding again here. A second decoder is the substitution
 * these paths exist to avoid: it would drift from the one the app actually uses
 * and the difference would show up as a coupon that cannot be spent.
 *
 * Returns an empty list rather than throwing for anything it cannot read. An
 * unreadable token is the gateway's problem to report, and failing here would
 * break an ordinary bearer receive that never needed a witness at all.
 */
export function secretsFromToken(token: string): string[] {
  try {
    const trimmed = token.trim()
    const body = trimmed.startsWith('cashu:') ? trimmed.slice(6) : trimmed
    // Locked proofs are only ever issued as V4. A cashuA token is legacy and
    // bearer, so there is nothing in one to sign; proofSecrets throws on it.
    if (!body.startsWith('cashuB')) return []
    return proofSecrets(body)
  } catch {
    return []
  }
}

/**
 * The witness header for a token about to be redeemed, or null.
 *
 * The single entry point for the receive path: hand it the token the customer
 * is redeeming and it returns either a header value or null. Null covers every
 * ordinary case — a bearer token, a coupon locked to somebody else, a wallet
 * that is not unlocked — and the caller then sends no header, leaving the wire
 * exactly as it was before locked coupons existed.
 *
 * Never throws. A receive that fails because signing failed would be worse
 * than one the mint refuses with a reason.
 */
export function witnessHeaderForToken(token: string): string | null {
  try {
    return witnessHeader(secretsFromToken(token))
  } catch {
    return null
  }
}
