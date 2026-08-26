import { finalizeEvent, type Event, type EventTemplate } from 'nostr-tools'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

import { getSigner } from './nap'
import { publish } from './relay'

/**
 * Public, pseudonymous proof that a coupon was redeemed.
 *
 * The sealed kind-7376 history (`txRecords.ts`) is the merchant's own record,
 * NIP-44 encrypted to their own key. Excellent for privacy, useless for audit:
 * nobody else can read it, so there is no way for a customer to check that the
 * stall really honoured their coupon, and no way for an auditor to see that the
 * books add up.
 *
 * This is the other half. One small unencrypted event per redemption, carrying
 * only what an audit needs and nothing that identifies the stall or its takings.
 *
 * ## What is published
 *
 * - `nullifier` — an opaque tag, unique per redeemed token
 * - `C` — a Pedersen commitment to the face value credited
 * - signed by a per-merchant LEDGER KEY that is not their identity key
 *
 * ## What it deliberately does NOT carry
 *
 * No merchant pubkey, no amount, no voucher id, no customer. A merchant
 * publishes a kind-0 naming their stall, so putting their identity key on a
 * public redemption record would let anyone compute that stall's revenue,
 * basket size and trading hours with a `GROUP BY`. The whole design exists to
 * avoid that.
 *
 * ## Why this is not redundant with the mint
 *
 * The mint prevents double-spend, but it operates on PROOFS and has no concept
 * of a voucher. It cannot distinguish a merchant crediting 2,500 XAF from one
 * crediting 1,800 against the same coupon — both burn 2,500 sats identically.
 * The face value credited lives only here.
 *
 * ## Publication cadence: one event per redemption
 *
 * A deliberate choice, not an oversight, and the one thing here that is
 * expected to change.
 *
 * Per-redemption publication is the simplest thing that works and the only
 * shape that lets a customer check their coupon the moment they are handed it —
 * which is the point of the feature. The cost is that even with an opaque
 * payload, the TIMING of the events is itself information: an observer
 * watching one ledger key learns that stall's trading hours and rhythm, and
 * roughly how busy it is, without ever reading an amount or a name.
 *
 * Batching (say, one event per day carrying many nullifiers) collapses that to
 * "traded on this day". It is a strictly better privacy position and a strictly
 * worse product one: a customer cannot verify a coupon that has not been
 * published yet, so the trust check would go from instant to next-day.
 *
 * Left per-redemption until someone decides that trade differently. What that
 * migration costs, checked against the staging relay rather than assumed:
 *
 * - The CUSTOMER check survives untouched. A batched event carries one `n` tag
 *   per nullifier, and a relay matches a `#n` filter against ALL of them —
 *   verified: a filter for a single nullifier matched an event carrying two.
 *   So `couponCheckFilter` keeps working across the change.
 * - The AUDITOR reader does NOT. Its content shape goes from one
 *   `{nullifier, commitment}` to a list, and a reader written for one breaks on
 *   the other. Whoever builds the reader should handle both from the start, or
 *   the migration needs a version tag.
 *
 * Design and the verification behind every claim:
 * `docs/research/redemption-attestation-privacy.md`.
 */

/**
 * A regular kind, like 7376 — relays keep every copy rather than replacing by
 * `d`. Append-only is exactly right for a redemption ledger; a replaceable kind
 * would let a later publish quietly erase an earlier redemption.
 *
 * 7377 sits beside NIP-60's 7375 (token) and 7376 (history) rather than in the
 * application range, because it is the same family of record. It is not a
 * registered NIP-60 kind; if one is standardised for this, move to it.
 */
export const ATTESTATION_KIND = 7377

/** Domain separators. Versioned, so a future scheme change cannot collide. */
const LEDGER_KEY_TAG = 'imani-ledger-key-v1'
const NULLIFIER_TAG = 'imani-redeem-v1'
const BLIND_TAG = 'imani-blind-v1'

/**
 * The merchant's ledger key — a pseudonym that is also a fetch handle.
 *
 * Attestations are signed by this key, so `{ authors: [ledgerPubkey] }` fetches
 * exactly one merchant's set. That is what makes "audit any merchant's numbers"
 * a single relay query rather than a scan.
 *
 * DERIVED FROM THE SECRET KEY, not the public one. This is the difference
 * between a pseudonym and a fig leaf: `issuerId` is signed inside every voucher
 * this merchant issues, so anyone holding one of their coupons knows their
 * public key. A ledger id hashed from that public key is recomputable by any of
 * their customers, and the pseudonym is broken by the first person who looks.
 *
 * Deterministic, so a merchant who wipes their device re-derives the same
 * identity and can still find and audit their own history.
 */
export function ledgerKey(): { sk: Uint8Array; pubkey: string } {
  const sk = sha256(utf8ToBytes(`${LEDGER_KEY_TAG}:${getSigner().privkeyHex()}`))
  return { sk, pubkey: bytesToHex(schnorr.getPublicKey(sk)) }
}

/**
 * The tag that makes a repeat redemption visible.
 *
 * Same token redeemed twice → same nullifier → anyone can see it. Monero calls
 * this a key image, for the same reason: it detects a double-spend without
 * revealing what was spent or by whom.
 *
 * **Keyed on the TOKEN, never on the voucher.** A £10 voucher legitimately
 * comes back as £4 and then £6 — `redemptionLedger.ts` says as much, "cashu
 * tokens can legitimately share the same voucher_id" — and a split preserves
 * voucher identity byte-for-byte. A voucher-keyed tag therefore collides on an
 * honest partial redemption and reports a double-spend that did not happen.
 *
 * **Bound to the token's own bytes, which are secret.** `token_id` is
 * `sha256(token)` and appears in the merchant's UI, so a tag derived from ids
 * alone could be computed — and PUBLISHED FIRST — by anyone who had seen the
 * coupon, framing an honest redemption as a replay. The full token is held only
 * by the parties to the payment.
 *
 * A customer who held the coupon can therefore recompute this themselves and
 * confirm their own redemption appears in the public ledger. That check is the
 * point of the whole feature.
 */
export function nullifierFor(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(`${NULLIFIER_TAG}:${token}`)))
}

/**
 * secp256k1 generator, and a second point with unknown discrete log wrt it.
 *
 * `H` must be a nothing-up-my-sleeve point: if anyone knew `x` such that
 * `H = x*G`, they could open a commitment to any value they liked and the
 * binding property would be worthless. Hash-and-increment from a fixed string
 * gives a point nobody chose.
 */
const CURVE_ORDER = schnorr.Point.Fn.ORDER
const G = schnorr.Point.BASE

let cachedH: typeof G | undefined
function pedersenH(): typeof G {
  if (cachedH) return cachedH
  for (let i = 0; i < 256; i++) {
    try {
      cachedH = schnorr.Point.fromHex(`02${bytesToHex(sha256(utf8ToBytes(`imani-pedersen-H:${i}`)))}`)
      return cachedH
    } catch {
      // x was not on the curve; try the next counter. Expected roughly half the
      // time, which is why this loops rather than asserting.
    }
  }
  throw new Error('could not derive the Pedersen H point')
}

/**
 * The blinding factor for one attestation, DERIVED rather than random.
 *
 * This is the choice that makes self-audit survive a device wipe. A random
 * blind would have to be stored, and a merchant who lost it could never re-open
 * their own commitment — they would be locked out of auditing their own
 * history by the very mechanism meant to protect it.
 *
 * Derived from the ledger key, so only this merchant can reproduce it: a
 * customer who knows the amount cannot locate the record, which is what stops
 * one known purchase from unmasking the pseudonym permanently.
 */
function blindFor(ledgerSk: Uint8Array, nullifier: string): bigint {
  const raw = BigInt(`0x${bytesToHex(sha256(utf8ToBytes(`${BLIND_TAG}:${bytesToHex(ledgerSk)}:${nullifier}`)))}`)
  // Never zero: a zero blind is no blind at all, and the commitment would
  // reduce to `amount * G`, which anyone could brute-force over plausible
  // amounts.
  return (raw % (CURVE_ORDER - 1n)) + 1n
}

/** `C = amount*G + r*H` — hides the amount, but is additively homomorphic. */
export function commitTo(amountMinorUnits: number, blind: bigint): string {
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits < 0) {
    throw new Error(`commitTo needs a non-negative integer amount, got ${amountMinorUnits}`)
  }
  const point =
    amountMinorUnits === 0
      ? pedersenH().multiply(blind)
      : G.multiply(BigInt(amountMinorUnits)).add(pedersenH().multiply(blind))
  return point.toHex(true)
}

/** What one attestation says, before it is signed. */
export interface Attestation {
  /** Opaque per-token tag. A repeat is a duplicate here. */
  nullifier: string
  /** Pedersen commitment to the credited face value. */
  commitment: string
  /** The unit, needed to audit sums. Not identifying on its own. */
  unit: string
}

/**
 * Build the event, signed by the LEDGER key rather than the wallet's identity.
 *
 * `finalizeEvent` rather than `signer.signEvent`, deliberately: the signer signs
 * as the merchant, and signing this as the merchant is precisely what the
 * design exists to avoid. Publishing the event IS the attestation — `pubkey`
 * and `sig` are a BIP-340 claim over the canonical serialisation, the same
 * scheme as the voucher signatures this wallet already verifies. No second
 * signature layer.
 */
export function buildAttestation(a: Attestation, ledgerSk: Uint8Array): Event {
  const template: EventTemplate = {
    kind: ATTESTATION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    // The nullifier is a tag as well as content so an auditor can look up one
    // coupon with a filter instead of fetching and parsing the whole stream —
    // which is exactly what a customer checking their own coupon does.
    tags: [
      ['n', a.nullifier],
      ['unit', a.unit],
    ],
    content: JSON.stringify({ nullifier: a.nullifier, commitment: a.commitment, unit: a.unit }),
  }
  return finalizeEvent(template, ledgerSk)
}

/**
 * Attest one redemption. NEVER THROWS.
 *
 * The money has already moved and the row is already written when this runs. A
 * relay that will not take the record has undone neither, so a failure here
 * must not turn a completed redemption into a reported error — the same rule
 * `publishVoucher` and `announceArrival` follow.
 *
 * The cost of a lost publish is one gap in the public ledger, which the
 * reconciliation sweep can republish later. That is why "absent" must never be
 * presented to a customer as proof of a dishonest merchant without the sweep
 * having run first.
 */
export async function attestRedemption(params: {
  token: string
  faceValue: number
  unit: string
}): Promise<void> {
  try {
    const { token, faceValue, unit } = params
    if (!token || !Number.isFinite(faceValue) || faceValue < 0) return

    const { sk } = ledgerKey()
    const nullifier = nullifierFor(token)
    const attestation: Attestation = {
      nullifier,
      commitment: commitTo(Math.round(faceValue), blindFor(sk, nullifier)),
      unit: unit || 'UNKNOWN',
    }

    const result = await publish(buildAttestation(attestation, sk))
    if (result.ok === 0) {
      console.warn('[attestation] no relay accepted the record', result.errors)
    }
  } catch (error) {
    console.error('[attestation] redemption not attested', error)
  }
}

/**
 * Re-open one's own commitment — the merchant self-audit primitive.
 *
 * Returns true when `amount` is what this attestation committed to. A merchant
 * on a new device holding only their key can re-derive every blind and check
 * their whole published history against their local rows.
 *
 * Only works for one's own attestations: another merchant's blind comes from
 * their ledger key, so the same amount produces a different commitment.
 */
export function verifyOwnCommitment(
  nullifier: string,
  commitment: string,
  amountMinorUnits: number,
): boolean {
  try {
    const { sk } = ledgerKey()
    return commitTo(Math.round(amountMinorUnits), blindFor(sk, nullifier)) === commitment
  } catch {
    return false
  }
}

/**
 * Prove a period total without revealing any single amount.
 *
 * Sums the blinds so an auditor can check `sum(C) == commit(total, sum(r))`.
 * The merchant discloses `total` and this scalar; the published commitments do
 * the rest. They cannot understate or overstate — a claimed total either
 * reconciles against commitments published before the dispute, or it does not.
 */
export function blindSumFor(nullifiers: string[]): string {
  const { sk } = ledgerKey()
  const sum = nullifiers.reduce((acc, n) => (acc + blindFor(sk, n)) % CURVE_ORDER, 0n)
  return sum.toString(16)
}

/**
 * The auditor's side of the same check. Needs no key and no wallet.
 *
 * @param commitments the published `C` values for the period
 * @param claimedTotal the total the merchant says they credited
 * @param blindSumHex the scalar they disclosed alongside it
 */
export function verifyDisclosedTotal(
  commitments: string[],
  claimedTotal: number,
  blindSumHex: string,
): boolean {
  try {
    if (commitments.length === 0) return false
    const sum = commitments
      .map((c) => schnorr.Point.fromHex(c))
      .reduce((a, b) => a.add(b))
    return sum.toHex(true) === commitTo(Math.round(claimedTotal), BigInt(`0x${blindSumHex}`))
  } catch {
    return false
  }
}

/** Exported for the audit reader; hex, matching how the relay carries keys. */
export function ledgerPubkey(): string {
  return ledgerKey().pubkey
}

/** Present so a caller can build a filter without reaching into internals. */
export function attestationFilter(ledgerPub: string) {
  return { kinds: [ATTESTATION_KIND], authors: [ledgerPub] }
}

/** The filter a CUSTOMER uses to check one coupon they hold. */
export function couponCheckFilter(token: string) {
  return { kinds: [ATTESTATION_KIND], '#n': [nullifierFor(token)] }
}
