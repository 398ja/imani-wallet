/**
 * The `delegated` issuance warrant a card purchase carries (imani-wallet#152).
 *
 * Until #152 a card coupon carried a `processor` warrant: a Stripe reference
 * and no signature. The till cannot check a reference, so it was this
 * service's word alone, and #152 made every till refuse it. This replaces it
 * with something the till CAN check, offline, without trusting this service:
 *
 * 1. **The stall's delegation.** A kind-30078 event the stall signed with its
 *    own key, naming this service's lock key for that stall (`p`), scope
 *    `coupon:issue`, and an expiry (`src/lib/issuerDelegation.ts`).
 * 2. **The delegate's signature** over the SAME sale digest a `merchant`
 *    warrant signs (`warrantSaleDigest` in `src/lib/issuanceWarrant.ts`), made
 *    with the terminal credential's lock key this service already holds per
 *    stall (`vault.ts`) and already signs NIP-98 with (`issuer.ts`).
 *
 * The processor reference stays, as `ref`, inside the signed bytes: it is no
 * longer evidence, it is what lets the stall reconcile the coupon against its
 * own Stripe dashboard.
 *
 * ## Why the digest and checks are restated here
 *
 * This image may not import from `src/` (the Dockerfile asserts it), so the
 * digest is restated, and `__tests__/delegatedWarrant.test.ts` pins it to the
 * till's by verifying what this module signs with the till's real verifier. A
 * divergence fails that test rather than every card coupon at the counter.
 */

import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'

import type { StallCredential } from './issuer'

/** Mirrors `FIELD_SEPARATOR` in `src/lib/issuanceWarrant.ts`. */
const FIELD_SEPARATOR = '\u001f'

/** Mirrors `DELEGATION_KIND` and `DELEGATION_SCOPE` in `src/lib/issuerDelegation.ts`. */
export const DELEGATION_KIND = 30078
export const DELEGATION_SCOPE = 'coupon:issue'

/** Mirrors `warrantSaleDigest` in `src/lib/issuanceWarrant.ts`. */
export function saleDigest(
  issuerId: string,
  saleTotalMinor: number,
  faceDecimals: number,
  unit: string,
  saleNonce: string,
): Uint8Array {
  const preimage = [issuerId, String(saleTotalMinor), String(faceDecimals), unit, saleNonce].join(
    FIELD_SEPARATOR,
  )
  return sha256(new TextEncoder().encode(preimage))
}

/**
 * The per-purchase nonce. DERIVED, not random, so every attempt at one
 * purchase sends a byte-identical body under the same idempotency key
 * (imani-wallet#96). Same derivation the processor warrant used.
 */
export function purchaseNonce(eventId: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`imani-purchase-warrant-v1:${eventId}`))).slice(
    0,
    32,
  )
}

export type DelegationCheck = { ok: true; event: Event } | { ok: false; reason: string }

/**
 * Is this credential's delegation one the till will accept, for a coupon that
 * lives until `couponExpiresAtMs`?
 *
 * Checked BEFORE minting, with the same rules the till applies, plus one the
 * till cannot apply: the delegation must outlive the COUPON. The till checks
 * expiry at redemption, so a delegation that lapses in March makes a coupon
 * sold in January unspendable in April. Refusing to mint under it now leaves
 * the debt for the stall to issue by hand, which is recoverable; minting a
 * coupon that dies early is not.
 */
export function checkDelegation(
  credential: StallCredential,
  couponExpiresAtMs: number,
): DelegationCheck {
  const refuse = (reason: string): DelegationCheck => ({ ok: false, reason })
  if (!credential.delegation) return refuse('the stall has not delegated coupon:issue to this issuer')

  let event: Event
  try {
    event = JSON.parse(credential.delegation) as Event
  } catch {
    return refuse('the stored delegation is not JSON')
  }
  if (!event || typeof event !== 'object' || event.kind !== DELEGATION_KIND || !Array.isArray(event.tags)) {
    return refuse('the stored delegation is not a delegation event')
  }
  if (String(event.pubkey).toLowerCase() !== credential.stallPubkey.toLowerCase()) {
    return refuse('the stored delegation is not signed by this stall')
  }
  // Parsed from JSON, so it carries no cached verdict to strip (see audit.ts).
  let signed = false
  try {
    signed = verifyEvent(event)
  } catch {
    signed = false
  }
  if (!signed) return refuse('the stored delegation signature does not verify')

  const tag = (name: string) => event.tags.filter((t) => t[0] === name).map((t) => t[1])
  const scopes = tag('scope')
  if (scopes.length !== 1 || scopes[0] !== DELEGATION_SCOPE) {
    return refuse(`the stored delegation is not scoped ${DELEGATION_SCOPE}`)
  }
  const delegates = tag('p')
  const ownKey = getPublicKey(hexToBytes(credential.lockKeyHex))
  if (delegates.length !== 1 || delegates[0] !== ownKey) {
    return refuse('the stored delegation names a different key than this credential’s lock key')
  }
  const expirations = tag('expiration')
  const expiresAt = Number(expirations[0])
  if (expirations.length !== 1 || !Number.isSafeInteger(expiresAt)) {
    return refuse('the stored delegation carries no single expiry')
  }
  if (expiresAt * 1000 < couponExpiresAtMs) {
    return refuse('the stored delegation expires before the coupon would; the stall must renew it')
  }
  return { ok: true, event }
}

/**
 * The warrant JSON for one card purchase, signed as the stall's delegate.
 *
 * Deterministic: the nonce is derived from the purchase and BIP-340's aux
 * randomness is fixed at zero (permitted by BIP-340; the nonce still derives
 * from the key and the message), so a retry sends the identical body.
 */
export function delegatedWarrant(input: {
  eventId: string
  issuerId: string
  saleTotalMinor: number
  faceDecimals: number
  unit: string
  reference: string | null
  lockKeyHex: string
  delegation: Event
}): string {
  const nonce = purchaseNonce(input.eventId)
  const digest = saleDigest(input.issuerId, input.saleTotalMinor, input.faceDecimals, input.unit, nonce)
  const sig = bytesToHex(schnorr.sign(digest, hexToBytes(input.lockKeyHex), new Uint8Array(32)))
  return JSON.stringify({
    form: 'delegated',
    sale_total: input.saleTotalMinor,
    face_decimals: input.faceDecimals,
    unit: input.unit,
    nonce,
    sig,
    delegation: {
      id: input.delegation.id,
      pubkey: input.delegation.pubkey,
      created_at: input.delegation.created_at,
      kind: input.delegation.kind,
      tags: input.delegation.tags,
      content: input.delegation.content,
      sig: input.delegation.sig,
    },
    ...(input.reference ? { ref: input.reference } : {}),
  })
}
