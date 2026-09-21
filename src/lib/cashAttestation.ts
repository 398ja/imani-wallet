/**
 * A customer's cash attestation: their own signature that they paid for a sale.
 *
 * ## Why this exists, and what it adds
 *
 * An issuance warrant proves the stall **authorised** issuing a value. It says
 * nothing about whether money arrived. On the card path a processor attests
 * that separately — a charge on the stall's own account, recorded by a party
 * outside our trust boundary. **On cash there is no third party at all.** The
 * only witnesses are the two people at the counter, so the only signature that
 * can attest payment is the customer's own.
 *
 * `docs/reply-issuance-warrant.md` §3 calls these two claims *authorisation*
 * and *consideration*. A warrant supplies the first. This supplies the second,
 * for the one rail where nothing else can.
 *
 * Not to be confused with `paymentReceipt.ts`, which is a different thing
 * entirely: that tells a SENDER their coupon was claimed. This is a CUSTOMER
 * telling a merchant they paid.
 *
 * ## Why it is OPTIONAL, and must stay that way
 *
 * Requiring it would put a second signing ceremony between a customer and their
 * coupon, at a counter, with a queue — to defend against a dispute between two
 * people who are both standing there. That is the trade `SellPage` was
 * deliberately simplified to avoid ("no cart, no line items, no payment
 * method"), and ADR 0009's reasoning about ceremony cost applies with more
 * force here than on the issuing side.
 *
 * So: a sale without an attestation is a normal sale. It is evidence a merchant
 * can collect when it is cheap — a regular customer, a large amount, a disputed
 * one — and its absence is never a refusal. Anything that makes a missing
 * attestation block a sale has misread this module.
 *
 * ## What it does NOT do
 *
 * It does not prove the notes were genuine, or that the amount handed over
 * matched what was typed. It proves a specific customer key asserted payment
 * for a specific sale. A customer who signs and then disputes is contradicting
 * their own signature, which is the entire point; a customer who never signs
 * leaves the merchant exactly where they are today.
 */
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { parseIssuanceWarrant } from './issuanceWarrant'

/**
 * Separates fields in the digest preimage. Same reasoning as the warrant's:
 * without it `total=25, decimals=00` and `total=2500, decimals=0` hash
 * identically, and an attestation for 25 would attest payment of 2500.
 */
const FIELD_SEPARATOR = '\u001f'

/**
 * The most an attestation may occupy, in characters.
 *
 * It arrives from a COUNTERPARTY, is written to the merchant's own row, and is
 * republished to a relay — so an unbounded one is a blob a hostile sender gets
 * to store in someone else's history and push through their bandwidth.
 *
 * A real one is around 300 characters: two 64-char pubkeys, a 128-char
 * signature, a short nonce and the surrounding JSON. 1024 is generous enough
 * that no honest attestation can hit it and tight enough to be worthless as a
 * storage channel, matching the budget `merchant_metadata` already uses.
 */
const MAX_ATTESTATION_CHARS = 1024

/** The sale an attestation refers to. */
export interface AttestedSale {
  stallPubkey: string
  saleTotalMinor: number
  faceDecimals: number
  unit: string
  /**
   * The sale's identity, taken from its warrant nonce.
   *
   * Binding to the SALE rather than to a coupon is what keeps this meaningful
   * across a split: one payment covers the whole sale, however many coupons the
   * portal decided to mint from it.
   */
  saleNonce: string
}

/** A customer's assertion that they paid for one sale. */
export interface CashAttestation extends AttestedSale {
  /** The customer's pubkey, hex. Who is asserting payment. */
  customerPubkey: string
  /** What they assert they paid, in minor units. */
  paidMinor: number
  /** The customer's BIP-340 signature over the digest. */
  signature: string
}

/**
 * The digest a customer signs.
 *
 * Deliberately includes **both** parties. An attestation naming only the amount
 * would be portable between stalls: a customer's genuine attestation for one
 * shop would attest payment at another. Including the customer's own key stops
 * a merchant reusing one customer's attestation under a different name.
 */
export function cashAttestationDigest(
  customerPubkey: string,
  stallPubkey: string,
  paidMinor: number,
  faceDecimals: number,
  unit: string,
  saleNonce: string,
): Uint8Array {
  if (!Number.isSafeInteger(paidMinor) || paidMinor < 0) {
    throw new Error('attested amount must be a non-negative integer in minor units')
  }
  const preimage = [
    customerPubkey,
    stallPubkey,
    String(paidMinor),
    String(faceDecimals),
    unit,
    saleNonce,
  ].join(FIELD_SEPARATOR)
  return sha256(new TextEncoder().encode(preimage))
}

/** What a check of an attestation concluded. */
export type CashAttestationVerdict =
  /** The customer signed for this sale, at this amount, to this stall. */
  | { verdict: 'attested' }
  /** None was collected. The ordinary case, and never a failure. */
  | { verdict: 'none' }
  /** One is present and does not hold. */
  | { verdict: 'invalid'; reason: string }

/**
 * Verifies an attestation against the sale it claims to pay for.
 *
 * The amount is checked for **equality**, not as a ceiling. A warrant is a
 * ceiling because one sale splits into many coupons; an attestation is a single
 * assertion about a single sale, so paying less than the sale total is not a
 * smaller valid attestation — it is one for a different amount than the sale
 * being reconciled, and silently accepting it would let a EUR 25.00 sale be
 * recorded against a customer's EUR 2.00 signature.
 */
export function verifyCashAttestation(
  attestation: CashAttestation | undefined,
  sale: AttestedSale,
): CashAttestationVerdict {
  if (!attestation) return { verdict: 'none' }

  if (attestation.saleNonce !== sale.saleNonce) {
    return { verdict: 'invalid', reason: 'attestation is for a different sale' }
  }
  if (attestation.stallPubkey !== sale.stallPubkey) {
    return { verdict: 'invalid', reason: 'attestation names a different stall' }
  }
  if (attestation.unit !== sale.unit || attestation.faceDecimals !== sale.faceDecimals) {
    return {
      verdict: 'invalid',
      reason:
        `attestation is in ${attestation.unit}(${attestation.faceDecimals}) ` +
        `but the sale is ${sale.unit}(${sale.faceDecimals})`,
    }
  }
  if (attestation.paidMinor !== sale.saleTotalMinor) {
    return {
      verdict: 'invalid',
      reason: `attestation is for ${attestation.paidMinor} but the sale is ${sale.saleTotalMinor}`,
    }
  }

  try {
    const digest = cashAttestationDigest(
      attestation.customerPubkey,
      attestation.stallPubkey,
      attestation.paidMinor,
      attestation.faceDecimals,
      attestation.unit,
      attestation.saleNonce,
    )
    const ok = schnorr.verify(
      hexToBytes(attestation.signature),
      digest,
      hexToBytes(attestation.customerPubkey),
    )
    return ok
      ? { verdict: 'attested' }
      : { verdict: 'invalid', reason: 'signature did not verify against the customer' }
  } catch (e) {
    // Malformed hex, wrong key length. Refuse rather than throw: a merchant is
    // mid-sale and an exception here would fail the sale over evidence that was
    // optional in the first place.
    return { verdict: 'invalid', reason: `attestation unreadable: ${(e as Error).message}` }
  }
}

/**
 * Signs an attestation with the customer's key.
 *
 * Takes raw key bytes rather than a signer because the caller is the customer's
 * own wallet, which holds its key and should decide how to borrow it —
 * `withPrivkey` there wipes its copy, and that policy belongs to the caller
 * rather than to this function.
 */
export function signCashAttestation(
  privateKey: Uint8Array,
  customerPubkey: string,
  sale: AttestedSale,
): CashAttestation {
  const digest = cashAttestationDigest(
    customerPubkey,
    sale.stallPubkey,
    sale.saleTotalMinor,
    sale.faceDecimals,
    sale.unit,
    sale.saleNonce,
  )
  return {
    customerPubkey,
    stallPubkey: sale.stallPubkey,
    paidMinor: sale.saleTotalMinor,
    saleTotalMinor: sale.saleTotalMinor,
    faceDecimals: sale.faceDecimals,
    unit: sale.unit,
    saleNonce: sale.saleNonce,
    signature: bytesToHex(schnorr.sign(digest, privateKey)),
  }
}

/** Parses a stored attestation, returning undefined rather than throwing. */
export function parseCashAttestation(
  raw: string | undefined | null,
): CashAttestation | undefined {
  if (!raw) return undefined
  // Checked before parsing, not after: JSON.parse on a hostile megabyte is the
  // cost this is meant to avoid.
  if (raw.length > MAX_ATTESTATION_CHARS) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const str = (k: string) => (typeof parsed[k] === 'string' ? (parsed[k] as string) : undefined)
    const num = (k: string) => (typeof parsed[k] === 'number' ? (parsed[k] as number) : undefined)

    const customerPubkey = str('customer')
    const stallPubkey = str('stall')
    const unit = str('unit')
    const saleNonce = str('nonce')
    const signature = str('sig')
    const paidMinor = num('paid')
    const faceDecimals = num('decimals')

    if (
      !customerPubkey ||
      !stallPubkey ||
      !unit ||
      !saleNonce ||
      !signature ||
      paidMinor === undefined ||
      faceDecimals === undefined
    ) {
      return undefined
    }

    return {
      customerPubkey,
      stallPubkey,
      paidMinor,
      saleTotalMinor: paidMinor,
      faceDecimals,
      unit,
      saleNonce,
      signature,
    }
  } catch {
    return undefined
  }
}

/** Serialises an attestation for storage on an issuance row. */
export function serialiseCashAttestation(attestation: CashAttestation): string {
  return JSON.stringify({
    customer: attestation.customerPubkey,
    stall: attestation.stallPubkey,
    paid: attestation.paidMinor,
    decimals: attestation.faceDecimals,
    unit: attestation.unit,
    nonce: attestation.saleNonce,
    sig: attestation.signature,
  })
}


/**
 * Builds the attestation a customer sends back with their receipt, or
 * undefined when there is nothing to attest.
 *
 * ## Where this runs
 *
 * On the CUSTOMER's device, at the moment a coupon is redeemed, beside the
 * receipt the wallet already posts to the sender. Not at a counter: see
 * `docs/attestation-ui-gap.md` for why a prompt during the sale would cost a
 * queue, be skipped under pressure, and be worse than useless against the
 * disputes it targets.
 *
 * ## Every failure is `undefined`, never a throw
 *
 * The redemption has already happened by the time this is called — the proofs
 * are burnt and the money has moved. An exception here would turn a completed
 * redemption into a reported failure over evidence that was optional in the
 * first place, which is the same posture `postPaymentReceipt` takes.
 *
 * Returns undefined when:
 *
 * - the coupon carries no warrant, so there is no sale to bind to. That is
 *   every coupon issued before warrants shipped, and it is a normal state
 *   rather than an error.
 * - the warrant is unreadable, or names a form with no sale figures.
 * - the wallet cannot sign.
 *
 * @param issuanceWarrant the warrant from the received coupon, verbatim
 * @param issuerId the stall that issued it, from the coupon's own signed tag
 * @param sign borrows the customer's key; the caller owns that policy
 */
export function attestationForReceivedCoupon(
  issuanceWarrant: string | undefined,
  issuerId: string,
  customerPubkey: string,
  sign: (digest: Uint8Array) => string,
): string | undefined {
  const warrant = parseIssuanceWarrant(issuanceWarrant)
  if (warrant.state !== 'present') return undefined

  try {
    const sale: AttestedSale = {
      // The stall from the COUPON's signed tag, not from the DM envelope.
      // Envelope fields are sender-written and unchecked, so attesting over
      // one would let a sender name whichever stall suited them.
      stallPubkey: issuerId,
      saleTotalMinor: warrant.saleTotalMinor,
      faceDecimals: warrant.faceDecimals,
      unit: warrant.unit,
      saleNonce: warrant.saleNonce,
    }

    const digest = cashAttestationDigest(
      customerPubkey,
      sale.stallPubkey,
      sale.saleTotalMinor,
      sale.faceDecimals,
      sale.unit,
      sale.saleNonce,
    )

    return serialiseCashAttestation({
      customerPubkey,
      stallPubkey: sale.stallPubkey,
      paidMinor: sale.saleTotalMinor,
      saleTotalMinor: sale.saleTotalMinor,
      faceDecimals: sale.faceDecimals,
      unit: sale.unit,
      saleNonce: sale.saleNonce,
      signature: sign(digest),
    })
  } catch (error) {
    console.warn('[attestation] could not attest a received coupon', error)
    return undefined
  }
}


/**
 * Whether an attestation arriving from a counterparty may be filed on a row.
 *
 * Extracted from the storage write-back so the DECISION can be tested without
 * a database, and so the rule lives beside the verification it depends on
 * rather than inside an IndexedDB call.
 *
 * Refuses, in order:
 *
 * - a row with an attestation already on it. A second receipt for one coupon
 *   is a redelivery, and replacing a verified attestation would reopen the
 *   substitution this whole check exists to close.
 * - a row with no warrant. There is no sale definition to check against, and
 *   storing an uncheckable signature is the hole this was written to fix.
 * - a row with no stall recorded. The stall MUST come from the row: taking it
 *   from the attestation would compare that field to itself and accept any
 *   stall an attacker cared to name.
 * - anything that does not verify against all three.
 */
export function mayFileAttestation(
  row: { cashAttestation?: string; issuanceWarrant?: string; merchantId?: string },
  attestation: string,
): { file: boolean; reason?: string } {
  if (row.cashAttestation) return { file: false, reason: 'already filed' }
  if (!row.merchantId) return { file: false, reason: 'row records no stall' }

  const warrant = parseIssuanceWarrant(row.issuanceWarrant)
  if (warrant.state !== 'present') {
    return { file: false, reason: 'row carries no warrant to check against' }
  }

  const verdict = verifyCashAttestation(parseCashAttestation(attestation), {
    stallPubkey: row.merchantId,
    saleTotalMinor: warrant.saleTotalMinor,
    faceDecimals: warrant.faceDecimals,
    unit: warrant.unit,
    saleNonce: warrant.saleNonce,
  })

  if (verdict.verdict === 'attested') return { file: true }
  return {
    file: false,
    reason: verdict.verdict === 'invalid' ? verdict.reason : verdict.verdict,
  }
}
