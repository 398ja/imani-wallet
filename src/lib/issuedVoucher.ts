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
import { reconcileIssuances, saleFor, saleIsComplete } from './reconcileIssuance'
import { isVoucherIssuance, warrantIssuedAt, type WalletTransaction } from './transactions'

export { isVoucherIssuance }

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

/**
 * One issued voucher and everything this device knows about its life.
 *
 * `VoucherRecord` rather than `IssuedVoucher`, which is the obvious name and
 * is taken: `issue.ts` exports an `IssuedVoucher` that is the gateway's wire
 * shape for a freshly minted coupon — `voucher_id`, `token`, `payment_state`.
 * Two different things under one name in one `src/lib` is how an import gets
 * auto-completed to the wrong module and a snake_case field read off a
 * camelCase object as undefined.
 */
export interface VoucherRecord {
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
  /**
   * Present when this coupon's signature holds but its sale's coupons add up to
   * less than the stall signed (#462): the figures the page states instead of
   * calling the signature into question.
   */
  shortfall?: { signedMinor: number; deliveredMinor: number; partlyDelivered: boolean }
}

/**
 * Is this incoming row one of ours coming home?
 *
 * Direction is read from `tx.direction`, which `toTransaction` DERIVES — the
 * stored field is hardcoded `'in'` by the writer, so reading it off the row
 * would count the stall's own issuance against its own ceiling. Same rule as
 * `redemptionLedger.priorRedemptionsOf`, deliberately.
 *
 * **The denomination check is not belt-and-braces.** Every other total in this
 * wallet refuses to sum across units — `merchantStats` drops them and counts
 * what it dropped, `outstandingLiability` takes one unit, `reconcileByUnit`
 * exists solely to stop it, and the warrant verifier puts its own unit check
 * FIRST because "numbers in different currencies are not comparable". A claim
 * sum is the same arithmetic and needs the same guard: `voucher_id` is the
 * gateway's id and nothing in this wallet's types stops a row carrying that id
 * in another denomination, so without this a 2500 XAF row could subtract from
 * a EUR 25.00 voucher and report it settled.
 *
 * Units compare by `sameUnit`, not `===`. Issuance stores the gateway's
 * `face_unit` as it came, so a stall whose gateway answered "xaf" would
 * otherwise never see a claim stamped "XAF", and the bar would read claimed 0
 * again: the #90 symptom by a different route.
 *
 * Exported for `merchantClaim.ts`, which must sum the same set to know how
 * much of a voucher is left to file against.
 */
export function isClaim(tx: WalletTransaction, issuance: WalletTransaction): boolean {
  return (
    tx.voucherId === issuance.voucherId &&
    tx.direction === 'in' &&
    sameUnit(tx.unit, issuance.unit) &&
    tx.decimals === issuance.decimals
  )
}

/**
 * One currency, however it was spelled.
 *
 * Trimmed and upper-cased, the same normalisation `format.ts` applies before
 * resolving decimals, so two spellings that resolve to the same decimals also
 * compare equal here.
 */
export function sameUnit(a: string | undefined, b: string | undefined): boolean {
  const norm = (u: string | undefined) => u?.trim().toUpperCase() ?? ''
  return norm(a) !== '' && norm(a) === norm(b)
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
  // A `delegated` warrant is how a card purchase is signed since #152: the
  // purchase issuer signs as the stall's delegate and carries the processor's
  // reference inside the signed bytes. A delegated warrant WITHOUT a reference
  // is some other delegate, so naming a rail for it would be a guess.
  if (warrant.form === 'delegated') {
    return warrant.reference ? { kind: 'card', reference: warrant.reference } : { kind: 'unknown' }
  }
  return { kind: 'counter' }
}

/**
 * Every voucher this history records issuing, newest first.
 *
 * `issued` rows, and `cashback` rows that carry a voucher id (#144). The portal
 * returns the id of the voucher a cashback code unlocks, and once a customer
 * claims it, that voucher is spent at this stall like any Sell coupon. So it
 * belongs on the same list.
 *
 * Why the cashback row itself rather than a second `issued` row beside it:
 * `reconcileIssuance.isIssuance` already counts both types as money taken at a
 * counter, so a twin `issued` row would count the same sale twice. It would
 * also be a second copy of the warrant and the expiry to keep in step, and a
 * second relay record to restore. One row, read by both lists, cannot drift.
 *
 * A cashback without a voucher id was issued before the portal returned one.
 * It stays off, for the routing reason below.
 *
 * A cashback and a Sell row cannot share a voucher id, so neither can hide the
 * other. Both ids are random UUIDs the gateway mints per voucher, and each
 * issue mints its own. The list keys rows by row id anyway (`issued:<id>`,
 * `cashback:<id>`), so even a collision would render both rows.
 *
 * Expired vouchers are excluded by DEFAULT rather than absent: they are the
 * ones a customer is most likely to turn up holding, and a merchant deciding
 * whether to honour one needs to be able to find it. Default off because the
 * live ones are what a merchant is trading against today.
 *
 * **A row with no `voucherId` is dropped**, and that is a routing fact rather
 * than tidiness. Every row this list renders links to
 * `/merchant/coupon/<voucherId>`; an empty id makes that
 * `/merchant/coupon/`, which matches no route and falls through App's
 * catch-all to the till. A merchant would tap a coupon and land on the home
 * screen with nothing explaining why. `buildIssueTransaction` always writes
 * one — it keys the row id on it — so this only ever catches a restored or
 * hand-edited row, which is precisely the row that would otherwise produce
 * that silent bounce.
 */
export function issuedVouchers(
  rows: readonly WalletTransaction[],
  { now, includeExpired = false }: { now: number; includeExpired?: boolean },
): WalletTransaction[] {
  return rows
    .filter((row) => isVoucherIssuance(row) && Boolean(row.voucherId))
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
): VoucherRecord | undefined {
  if (!voucherId) return undefined

  const row = rows.find((tx) => isVoucherIssuance(tx) && tx.voucherId === voucherId)
  if (!row) return undefined

  const claims = rows.filter((tx) => isClaim(tx, row)).sort((a, b) => b.at - a.at)
  const claimedMinor = claims.reduce(
    (total, tx) => total + (Number.isFinite(tx.amount) ? tx.amount : 0),
    0,
  )

  const warrant = parseIssuanceWarrant(row.issuanceWarrant)
  // Judged at the moment the sale was recorded, not today: a card sale made
  // under a live delegation stays authorised in the stall's ledger after the
  // delegation lapses (#176 review). A row with no recorded time (0) falls
  // back to the current clock. A card row re-dated to its payment is judged at
  // its mint time, which a delegation signed between the two still covers (#648).
  const issuedAt = warrantIssuedAt(row)
  const warrantVerdict = verifyIssuanceWarrant(
    warrant,
    stallPubkey,
    { faceValueMinor: row.amount, unit: row.unit, faceDecimals: row.decimals },
    issuedAt !== undefined ? { issuedAt } : {},
  )

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
    shortfall: shortfallFor(rows, row, stallPubkey),
  }
}

/**
 * The same sale-level judgement the "Coupons you issued" panel makes, for one
 * row (#462). Summing a sale needs its siblings, so this reconciles the rows
 * that share this row's warrant rather than re-deriving the rule here.
 */
function shortfallFor(
  rows: readonly WalletTransaction[],
  row: WalletTransaction,
  stallPubkey: string,
): VoucherRecord['shortfall'] {
  if (!row.issuanceWarrant) return undefined
  const found = reconcileIssuances(rows, stallPubkey).find((item) => item.row === row)
  if (found?.verdict !== 'understated' || !found.sale) return undefined
  const { signedMinor, deliveredMinor, partlyDelivered } = found.sale
  return { signedMinor, deliveredMinor, partlyDelivered }
}
