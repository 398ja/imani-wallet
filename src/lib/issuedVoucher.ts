/**
 * One voucher this stall issued, read back as a whole.
 *
 * ## The question
 *
 * A merchant's issuance row says what they put into the world. It does not say
 * what happened next, and "what happened next" is spread across four places
 * this wallet already holds and has never joined up:
 *
 *  - **What came back.** Incoming rows carrying the same `voucher_id`. A coupon
 *    is spent down rather than used up, so a voucher legitimately returns more
 *    than once and the answer is a SUM, not a flag. `redemptionLedger.ts`
 *    already sums it to enforce a ceiling at the till; this asks the same
 *    question for a merchant reading their books, so the arithmetic lives here
 *    once and both callers get the same number.
 *  - **What authorised it.** The issuance warrant stored on the row, re-checked
 *    against the row beside it rather than re-read — see `reconcileIssuance.ts`.
 *  - **Whether the customer said they paid.** The cash attestation, which is a
 *    different claim from the warrant and must stay separate from it.
 *  - **Which rail took the money**, below.
 *
 * ## Cash or card, and why this refuses to guess
 *
 * A merchant asks "was this one paid in cash or on a card", and the honest
 * answer has three values rather than two.
 *
 *  - **Card** is the one state with evidence: a `processor` warrant is, by
 *    construction, a payment processor's record standing in for a signature —
 *    "a processor references an external record instead of signing"
 *    (`issuanceWarrant.ts`). Nothing else on this stack produces that form.
 *  - **Counter** is a sale the stall itself signed for on its own device, which
 *    is the Sell flow: somebody stood at the stall and handed money over.
 *    `cashAttestation.ts` is explicit that on this rail "there is no third
 *    party at all", so the attestation below is the only corroboration that can
 *    ever exist for it — which is exactly why the two are reported separately.
 *  - **Unknown** is everything else, and it is not a defect: it is every sale
 *    issued before warrants shipped, and every sale made on a terminal, whose
 *    key is not the stall's and which therefore issues a signed `none`
 *    (`warrantSigner.ts`). Printing "cash" over those would be this module
 *    inventing a fact about money, which is the one thing it must not do.
 */
import {
  parseCashAttestation,
  verifyCashAttestation,
  type CashAttestation,
  type CashAttestationVerdict,
} from './cashAttestation'
import {
  parseIssuanceWarrant,
  verifyIssuanceWarrant,
  type IssuanceWarrant,
  type WarrantVerdict,
} from './issuanceWarrant'
import { saleFor, saleIsComplete } from './reconcileIssuance'
import type { WalletTransaction } from './transactions'

/** How the customer paid for the voucher, as far as the record can say. */
export type PaymentRail =
  /**
   * A processor recorded the payment. `reference` is its own record id when the
   * warrant carried one — the handle a merchant takes to their processor.
   */
  | { kind: 'card'; reference?: string }
  /** Sold at the stall, on the stall's own key. Cash, or whatever was handed over. */
  | { kind: 'counter' }
  /** Nothing on the row says. Not a fault — see the module note. */
  | { kind: 'unknown' }

/** One issued voucher and everything this device knows about its life. */
export interface IssuedVoucher {
  /** The issuance row itself: amount, unit, memo, customer, expiry. */
  row: WalletTransaction
  /** Against `now` as the caller captured it, never a fresh clock read. */
  expired: boolean
  /** Face value returned so far, in minor units. Summed, not counted. */
  claimedMinor: number
  /**
   * What is still out there, floored at zero.
   *
   * Floored for `outstandingLiability`'s reason: redemptions are matched to
   * issuance by voucher id, and a coupon can come back worth more than one row
   * recorded if history was restored in pieces. A negative liability would read
   * as the stall being owed money, which is the wrong direction to be wrong in.
   */
  outstandingMinor: number
  /** Incoming rows against this voucher, newest first. The claims themselves. */
  claims: WalletTransaction[]
  /** The warrant as stored, in its three absence states plus `invalid`. */
  warrant: IssuanceWarrant
  /** That warrant re-checked against THIS row's amount and denomination. */
  warrantVerdict: WarrantVerdict
  /** The customer's own signature that they paid, when one was collected. */
  attestation?: CashAttestation
  /** `none` is the ordinary case and never a failure. */
  attestationVerdict: CashAttestationVerdict
  rail: PaymentRail
  /** Every row from the same sale, this one included. See `saleFor`. */
  sale: WalletTransaction[]
  /** Whether all of that sale's coupons are present in this history. */
  saleComplete: boolean
}

/**
 * Is this incoming row one of ours coming home?
 *
 * Direction is read from `tx.direction`, which `toTransaction` DERIVES — the
 * stored field is hardcoded `'in'` by the writer, so reading it off the row
 * would count the stall's own issuance against its own ceiling. Same rule as
 * `redemptionLedger.priorRedemptionsOf`, deliberately.
 */
function isClaim(tx: WalletTransaction, voucherId: string): boolean {
  return tx.voucherId === voucherId && tx.direction === 'in'
}

/** Has this issuance lapsed, as of the moment the caller loaded its rows? */
export function isExpired(row: WalletTransaction, now: number): boolean {
  return row.expiresAt !== undefined && row.expiresAt <= now
}

/**
 * Which rail paid for a sale. See the module note for why `unknown` exists.
 *
 * Read from the warrant rather than from a stored flag, because no row has ever
 * carried a rail field: the evidence is the warrant's FORM, which is written at
 * issuance by whoever could sign and is covered by the same digest as the
 * amount. A flag would be a second, unsigned claim about the same fact.
 */
export function paymentRail(warrant: IssuanceWarrant): PaymentRail {
  if (warrant.state !== 'present') return { kind: 'unknown' }
  if (warrant.form === 'processor') return { kind: 'card', reference: warrant.reference }
  // `merchant` only. A `delegated` warrant is not verifiable in this build
  // (`verifyIssuanceWarrant` refuses it rather than half-checking), so naming a
  // rail for it would assert more than the verifier is willing to.
  return warrant.form === 'merchant' ? { kind: 'counter' } : { kind: 'unknown' }
}

/**
 * Every voucher this history records issuing, newest first.
 *
 * `issued` only, not `cashback`. A cashback is an issuance for reconciliation —
 * `reconcileIssuance.isIssuance` counts both, because both take money at a
 * counter — and it is NOT one here, because there is no voucher: the customer
 * has no wallet, the code was read out loud, and its life is answered by the
 * gateway rather than by rows in this history. It has its own screen for
 * exactly that reason (`CashbackSection`), and mixing it in would put rows in
 * this list whose "claimed" figure could only ever be zero.
 *
 * Expired vouchers are excluded by DEFAULT rather than absent: they are the
 * ones a customer is most likely to turn up holding, and a merchant deciding
 * whether to honour one needs to be able to find it. Default off because the
 * live ones are what a merchant is trading against today.
 */
export function issuedVouchers(
  rows: readonly WalletTransaction[],
  { now, includeExpired = false }: { now: number; includeExpired?: boolean },
): WalletTransaction[] {
  return rows
    .filter((row) => row.type === 'issued')
    .filter((row) => includeExpired || !isExpired(row, now))
    .sort((a, b) => b.at - a.at)
}

/**
 * One issued voucher, joined up.
 *
 * `stallPubkey` is the key the warrant must verify against — the stall's own,
 * since that is what a `merchant` warrant is signed by and what `issuerId`
 * names on the coupon. Passing the ledger key instead would report every sale
 * as a mismatch, which is the trap `App.tsx` already notes at `/settings/ledger`.
 *
 * Returns undefined when this history has no issuance row for the id. That
 * means "not in my records", never "not issued" — a coupon sold on another
 * terminal is not in this history either.
 */
export function issuedVoucher(
  rows: readonly WalletTransaction[],
  voucherId: string,
  { now, stallPubkey }: { now: number; stallPubkey: string },
): IssuedVoucher | undefined {
  if (!voucherId) return undefined

  const row = rows.find((tx) => tx.type === 'issued' && tx.voucherId === voucherId)
  if (!row) return undefined

  const claims = rows.filter((tx) => isClaim(tx, voucherId)).sort((a, b) => b.at - a.at)
  const claimedMinor = claims.reduce(
    (total, tx) => total + (Number.isFinite(tx.amount) ? tx.amount : 0),
    0,
  )

  const warrant = parseIssuanceWarrant(row.issuanceWarrant)
  const warrantVerdict = verifyIssuanceWarrant(warrant, stallPubkey, {
    faceValueMinor: row.amount,
    unit: row.unit,
    faceDecimals: row.decimals,
  })

  const attestation = parseCashAttestation(row.cashAttestation)
  // Checked against the SALE the warrant describes rather than against this
  // row, because one payment covers a whole sale however many coupons it
  // became. With no warrant there is no sale nonce to bind to, so there is
  // nothing an attestation could be checked against — `none`, not `invalid`.
  const attestationVerdict: CashAttestationVerdict =
    warrant.state === 'present'
      ? verifyCashAttestation(attestation, {
          stallPubkey,
          saleTotalMinor: warrant.saleTotalMinor,
          faceDecimals: warrant.faceDecimals,
          unit: warrant.unit,
          saleNonce: warrant.saleNonce,
        })
      : { verdict: 'none' }

  return {
    row,
    expired: isExpired(row, now),
    claimedMinor,
    outstandingMinor: Math.max(0, row.amount - claimedMinor),
    claims,
    warrant,
    warrantVerdict,
    attestation,
    attestationVerdict,
    rail: paymentRail(warrant),
    sale: saleFor(rows, voucherId),
    saleComplete: saleIsComplete(rows, voucherId),
  }
}
