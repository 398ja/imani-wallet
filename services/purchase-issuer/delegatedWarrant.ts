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
 * 2. **The delegate's signature** over the sale digest's fields plus the
 *    processor reference (`delegatedSaleDigest` in
 *    `src/lib/issuanceWarrant.ts`), made with the terminal credential's lock
 *    key this service already holds per stall (`vault.ts`) and already signs
 *    NIP-98 with (`issuer.ts`).
 *
 * The processor reference stays, as `ref`, and the delegate signs it: it is no
 * longer evidence, it is what lets the stall reconcile the coupon against its
 * own Stripe dashboard, so an edit to it must fail verification.
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

/**
 * Mirrors `DELEGATION_KIND`, `DELEGATION_SCOPE` and `DELEGATION_D_TAG` in
 * `src/lib/issuerDelegation.ts`.
 */
export const DELEGATION_KIND = 30078
export const DELEGATION_SCOPE = 'coupon:issue'
export const DELEGATION_D_TAG = 'imani:issuer-delegation'

/**
 * How much longer than the coupon a delegation must last.
 *
 * The till checks a delegation against its OWN clock, because a coupon carries
 * no signed issue time, and a till's clock can run ahead. The gateway also
 * stamps the coupon's expiry slightly after this service asks for it. A week
 * covers both, so a coupon never dies at the counter in its last days.
 */
export const DELEGATION_SKEW_MARGIN_MS = 7 * 86_400_000

/** Mirrors `delegatedSaleDigest` in `src/lib/issuanceWarrant.ts`. */
export function saleDigest(
  issuerId: string,
  saleTotalMinor: number,
  faceDecimals: number,
  unit: string,
  saleNonce: string,
  reference: string | null,
): Uint8Array {
  const preimage = [
    issuerId,
    String(saleTotalMinor),
    String(faceDecimals),
    unit,
    saleNonce,
    reference ?? '',
  ].join(FIELD_SEPARATOR)
  return sha256(new TextEncoder().encode(preimage))
}

/**
 * The per-purchase nonce. DERIVED, not random, so every attempt at one
 * purchase sends a byte-identical body under the same idempotency key
 * (imani-wallet#96). From the PAYMENT INTENT since imani-wallet#274 (v2): gc
 * records the voucher per nonce (gc#232), so any re-drive of one payment, under
 * any event id, gets the original voucher back rather than a second one.
 */
export function purchaseNonce(paymentIntent: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`imani-purchase-warrant-v2:${paymentIntent}`))).slice(
    0,
    32,
  )
}

/**
 * Why a delegation cannot back a coupon. `code` is set only for the two that are about the
 * coupon's LIFE rather than the delegation itself (imani-wallet#312), because those need a
 * different answer: nothing is wrong with the delegation, the stall's term is longer than it.
 *
 * - `never_expires`: the stall's coupons never expire, and no finite delegation outlives one. The
 *   till checks the delegation against its own clock at redemption (`verifyIssuerDelegation`), so
 *   such a coupon would die at the counter the day the delegation lapses.
 * - `outlives_delegation`: a finite term that ends after the delegation (less the margin).
 */
export type DelegationCheck =
  | { ok: true; event: Event }
  | { ok: false; reason: string; code?: 'never_expires' | 'outlives_delegation' }

/** Epoch ms a coupon minted at `nowMs` for `days` expires, or null for never (`days === 0`). */
export function couponExpiresAtMs(nowMs: number, days: number): number | null {
  return days === 0 ? null : nowMs + days * 86_400_000
}

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
 *
 * It must outlive the coupon by `DELEGATION_SKEW_MARGIN_MS`, not merely reach
 * its last day. This stays a whole-coupon-lifetime requirement, rather than
 * "valid when issued", because the till has no signed issue time to judge the
 * delegation at (see `verifyIssuerDelegation`). Shorter rolling delegations
 * need the voucher to carry one first.
 */
export function checkDelegation(
  credential: StallCredential,
  /** Epoch ms the coupon would expire, or null for a coupon that never expires. */
  couponExpiresAtMs: number | null,
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
  const dTags = tag('d')
  if (dTags.length !== 1 || dTags[0] !== DELEGATION_D_TAG) {
    return refuse(`the stored delegation is not the ${DELEGATION_D_TAG} record`)
  }
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
  if (couponExpiresAtMs === null) {
    return {
      ok: false,
      code: 'never_expires',
      reason:
        'the stall\u2019s coupons never expire, and a delegated card coupon cannot outlive its delegation; the stall must set a voucher validity',
    }
  }
  if (expiresAt * 1000 < couponExpiresAtMs + DELEGATION_SKEW_MARGIN_MS) {
    return {
      ok: false,
      code: 'outlives_delegation',
      reason: 'the stored delegation does not outlive the coupon by a week; the stall must renew it',
    }
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
  /** The payment intent (pi_), which the nonce derives from. */
  paymentIntent: string
  issuerId: string
  saleTotalMinor: number
  faceDecimals: number
  unit: string
  reference: string | null
  lockKeyHex: string
  delegation: Event
}): string {
  const nonce = purchaseNonce(input.paymentIntent)
  const digest = saleDigest(
    input.issuerId,
    input.saleTotalMinor,
    input.faceDecimals,
    input.unit,
    nonce,
    input.reference,
  )
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
