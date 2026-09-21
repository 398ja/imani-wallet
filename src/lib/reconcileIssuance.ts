/**
 * Reconciling a merchant's own issuance history against what they signed.
 *
 * ## The question this answers
 *
 * A merchant asks "does the cash in my till match the coupons I issued?" and
 * today the only available answer is arithmetic over a ledger they believe
 * because it is theirs. That is usually enough for a stall counting its own
 * takings, and it stops being enough the moment the question turns adversarial:
 * a terminal operator disputing what they issued, or an owner auditing a device
 * they did not watch.
 *
 * With the warrant stored on the row (`buildIssueTransaction`), the same
 * history becomes checkable rather than merely trusted: every `issued` row can
 * be re-verified against the stall's own key, by anyone holding the row.
 *
 * ## What this does NOT establish, and it matters
 *
 * A warrant proves the stall **authorised issuing this value**. It does not
 * prove **money arrived**. On the card path a processor attests that separately;
 * on cash there is no third party, so consideration is unattested by nature —
 * the only witnesses are the two people at the counter.
 *
 * So a clean reconciliation here means "every coupon I issued, I meant to
 * issue". A merchant who wants "and I was paid for each one" needs a till count,
 * and no amount of signing reaches that fact. See
 * `docs/cash-warrant-reconciliation.md`.
 */
import { parseCashAttestation, verifyCashAttestation } from './cashAttestation'
import { parseIssuanceWarrant, verifyIssuanceWarrant } from './issuanceWarrant'
import type { WalletTransaction } from './transactions'

/**
 * Whether a row is this stall putting a claim into the world.
 *
 * `issued` is a coupon sent to a named customer; `cashback` is a code read out
 * loud to someone with no wallet yet. Both take money at a counter and both
 * are the merchant's own liability, so both belong in a reconciliation.
 *
 * The difference matters elsewhere and not here: a cashback can never carry a
 * customer attestation, because there is no recipient to send one back.
 */
function isIssuance(row: WalletTransaction): boolean {
  return row.type === 'issued' || row.type === 'cashback'
}

/** How one issuance row stands up to being re-checked. */
export type ReconciledIssuance = {
  row: WalletTransaction
  /**
   * `authorised` — the stall's signature over this sale verifies.
   * `unwarranted` — the row carries no warrant, so nothing but this device's
   *   own record says the sale happened. Not necessarily wrong: it is every
   *   row written before warrants, and every sale made while locked.
   * `mismatch` — a warrant is present and does NOT verify. The one that wants
   *   looking at, because it means the row and the signature disagree.
   */
  verdict: 'authorised' | 'unwarranted' | 'mismatch'
  /** Why, when the verdict is `mismatch`. */
  reason?: string
  /**
   * Whether the CUSTOMER attested paying for this sale.
   *
   * Reported separately from `verdict`, and that separation is the point. The
   * verdict answers *did the stall authorise this?*; this answers *did anyone
   * say money arrived?* They are different claims — authorisation and
   * consideration — and collapsing them would let a merchant read a warrant as
   * proof of payment, which it has never been.
   *
   * `'none'` is the ordinary case. A sale with no attestation is a normal sale,
   * and it never makes the verdict worse.
   */
  paid: 'attested' | 'none' | 'invalid'
}

/**
 * Re-checks each `issued` row against the warrant stored on it.
 *
 * `stallPubkey` is the key the warrants must verify against — the stall's own,
 * since that is what a `merchant` warrant is signed by and what `issuerId`
 * names on the coupons.
 *
 * Rows that are not issuances are skipped rather than reported, because a
 * reconciliation listing every receipt as "not an issuance" is noise that
 * trains people to skim.
 */
export function reconcileIssuances(
  rows: readonly WalletTransaction[],
  stallPubkey: string,
): ReconciledIssuance[] {
  const out: ReconciledIssuance[] = []

  for (const row of rows) {
    // Both rails that MINT value against this stall. A cashback is a sale like
    // any other - the merchant took money and put a claim into the world - and
    // leaving it out would let the one rail with no possible customer receipt
    // also escape the merchant's own audit.
    if (!isIssuance(row)) continue

    if (!row.issuanceWarrant) {
      // No warrant means no sale nonce, so there is nothing an attestation
      // could be checked against. Reported as `none` rather than `invalid`:
      // the attestation is not wrong, there is simply nothing to bind it to.
      out.push({ row, verdict: 'unwarranted', paid: 'none' })
      continue
    }

    const warrant = parseIssuanceWarrant(row.issuanceWarrant)

    // Verified against THIS ROW's amount and denomination, which is the whole
    // point of re-checking rather than re-reading. A stored warrant that no
    // longer covers the row beside it means one of the two was altered after
    // the fact, and that is exactly the tampering an audit is looking for.
    const verdict = verifyIssuanceWarrant(warrant, stallPubkey, {
      faceValueMinor: row.amount,
      unit: row.unit,
      faceDecimals: row.decimals,
    })

    // Checked against the SALE the warrant describes, not against the row,
    // because one payment covers a whole sale however many coupons it became.
    const paid =
      warrant.state === 'present'
        ? verifyCashAttestation(parseCashAttestation(row.cashAttestation), {
            stallPubkey,
            saleTotalMinor: warrant.saleTotalMinor,
            faceDecimals: warrant.faceDecimals,
            unit: warrant.unit,
            saleNonce: warrant.saleNonce,
          }).verdict
        : ('none' as const)

    if (verdict.verdict === 'verified' || verdict.verdict === 'claimed') {
      // The signature holds and the row fits under the warranted total. For
      // RECONCILIATION that is not quite enough, because a ceiling is one-sided
      // by design: a warrant for 2500 legitimately covers a 900 coupon, since
      // sales split and coupons are spent down. On a merchant's own ledger,
      // though, an `issued` row IS the sale - it is written per part at that
      // part's value, and the parts of one sale sum to the warranted total.
      //
      // So a row claiming LESS than its warrant, with no sibling rows making up
      // the difference, is understated - the shape someone would produce to
      // hide takings. Checked here rather than in the verifier because only a
      // ledger can see the siblings; a coupon in isolation cannot.
      out.push({ row, verdict: 'authorised', paid })
    } else if (verdict.verdict === 'unwarranted' || verdict.verdict === 'absent') {
      // A signed `none`, or a warrant that parsed to nothing. The stall put its
      // name to "nothing authorised this", which reconciles as unwarranted
      // rather than as a mismatch: it is an honest record of an unbacked sale.
      out.push({ row, verdict: 'unwarranted', paid })
    } else {
      out.push({ row, verdict: 'mismatch', reason: verdict.reason, paid })
    }
  }

  return flagUnderstatedSales(out)
}

/**
 * Flags sales whose rows do not add up to the total their warrant authorised.
 *
 * A warrant covers a SALE, and one sale may be several rows because the portal
 * splits an oversized amount. Each row verifies individually - a ceiling accepts
 * anything at or under the total - so understating a sale by deleting or
 * shrinking a row passes every per-row check while the ledger silently loses
 * money.
 *
 * Grouping by the warrant catches it: the rows that share a warrant must sum to
 * the total it names. Over-summing is flagged too, since rows totalling MORE
 * than the stall authorised is the forgery the ceiling exists to refuse,
 * arriving by a route a single row cannot show.
 *
 * Rows with no warrant are left alone; there is nothing to sum against.
 */
function flagUnderstatedSales(items: ReconciledIssuance[]): ReconciledIssuance[] {
  // Grouped by the sale NONCE, not by the warrant JSON.
  //
  // The JSON is the wrong key and it fails in a way that looks like it works:
  // BIP-340 signing uses fresh auxiliary randomness, so the same sale signed
  // twice produces different bytes. Grouping on the text would put every part
  // of a split sale in its own group of one, every group would trivially sum to
  // itself, and the check would pass on everything - including the understated
  // sale it exists to catch. Found by a test that expected a valid split to
  // reconcile and watched all three parts come back `mismatch`.
  //
  // The nonce is the sale's identity: fresh per sale by construction, and
  // inside the digest, so it cannot be edited without breaking the signature
  // that was already verified above.
  const bySale = new Map<string, { warrantTotal: number; group: ReconciledIssuance[] }>()
  for (const item of items) {
    if (item.verdict !== 'authorised' || !item.row.issuanceWarrant) continue
    const warrant = parseIssuanceWarrant(item.row.issuanceWarrant)
    if (warrant.state !== 'present') continue

    // Scoped to the issuer's own currency too, so two stalls' sales cannot
    // share a bucket on a nonce collision.
    const key = `${warrant.saleNonce}\u001f${warrant.unit}\u001f${warrant.saleTotalMinor}`
    const bucket = bySale.get(key)
    if (bucket) bucket.group.push(item)
    else bySale.set(key, { warrantTotal: warrant.saleTotalMinor, group: [item] })
  }

  for (const { warrantTotal, group } of bySale.values()) {
    const summed = group.reduce(
      (total, item) => total + (Number.isFinite(item.row.amount) ? item.row.amount : 0),
      0,
    )
    if (summed === warrantTotal) continue

    const direction = summed < warrantTotal ? 'understated' : 'overstated'
    for (const item of group) {
      item.verdict = 'mismatch'
      item.reason =
        `sale ${direction}: rows for this warrant total ${summed} ` +
        `but it authorised ${warrantTotal}`
    }
  }

  return items
}

/**
 * The sale a coupon came from, and everything issued beside it.
 *
 * This is the question a merchant actually asks when a customer presents a
 * coupon back to them: *which sale was this, and is the rest of it accounted
 * for?* Answering it needs the sibling ids recorded at issuance
 * (`saleVoucherIds`), because a coupon carries its warrant but not the identity
 * of the other coupons that warrant covers.
 *
 * Returns the rows in issuance order, the first of which may or may not be the
 * one asked about — callers wanting to highlight it should match on
 * `voucherId` themselves rather than assume a position.
 *
 * **Only finds what this device recorded.** A coupon issued on another terminal
 * is not in this history, and neither is one a compromised service minted
 * without telling anyone. An empty result means "not in my records", never "not
 * issued".
 */
export function saleFor(
  rows: readonly WalletTransaction[],
  voucherId: string,
): WalletTransaction[] {
  const direct = rows.find((row) => row.type === 'issued' && row.voucherId === voucherId)
  if (!direct) return []

  // A single-coupon sale carries no sibling list, and is its own whole sale.
  if (!direct.saleVoucherIds || direct.saleVoucherIds.length === 0) return [direct]

  const ids = new Set(direct.saleVoucherIds)
  return rows.filter(
    (row) => row.type === 'issued' && row.voucherId !== undefined && ids.has(row.voucherId),
  )
}

/**
 * Whether every coupon of a sale is present in this history.
 *
 * A sale whose rows are missing is the shape of a partial delivery, a device
 * that failed mid-sale, or history that has been edited. Distinguishing those
 * is a human's job; surfacing that they differ is this function's.
 */
export function saleIsComplete(
  rows: readonly WalletTransaction[],
  voucherId: string,
): boolean {
  const sale = saleFor(rows, voucherId)
  if (sale.length === 0) return false

  const expected = sale[0]?.saleVoucherIds
  if (!expected || expected.length === 0) return sale.length === 1

  return sale.length === expected.length
}

/** A day's takings, split by whether the stall can prove it authorised them. */
export interface ReconciliationTotals {
  /** Sum of rows whose warrant verifies, in minor units. */
  authorisedMinor: number
  /** Sum of rows carrying no usable warrant. */
  unwarrantedMinor: number
  /** Sum of rows whose warrant is present and does not verify. */
  mismatchedMinor: number
  /**
   * Of the authorised total, how much the CUSTOMER also attested paying.
   *
   * Always <= `authorisedMinor`. The gap is sales the stall authorised and
   * nobody corroborated, which on cash is most of them and is not a problem —
   * it is the figure a merchant would have to defend if a sale were disputed.
   */
  attestedMinor: number
  /** Row counts, since one large mismatch and fifty small ones differ. */
  counts: { authorised: number; unwarranted: number; mismatch: number }
}

/**
 * Totals a reconciliation, so the figure a merchant compares to their till is
 * separated from the figure they cannot vouch for.
 *
 * **Amounts are summed only within one unit.** Callers must reconcile per
 * currency: adding 2500 XAF to 2500 EUR produces a number that means nothing,
 * and this function cannot tell that it happened. `reconcileByUnit` does the
 * grouping for callers who hold mixed history.
 */
export function totalReconciliation(
  reconciled: readonly ReconciledIssuance[],
): ReconciliationTotals {
  const totals: ReconciliationTotals = {
    authorisedMinor: 0,
    unwarrantedMinor: 0,
    mismatchedMinor: 0,
    attestedMinor: 0,
    counts: { authorised: 0, unwarranted: 0, mismatch: 0 },
  }

  for (const item of reconciled) {
    const amount = Number.isFinite(item.row.amount) ? item.row.amount : 0
    if (item.verdict === 'authorised') {
      totals.authorisedMinor += amount
      totals.counts.authorised += 1
      if (item.paid === 'attested') totals.attestedMinor += amount
    } else if (item.verdict === 'unwarranted') {
      totals.unwarrantedMinor += amount
      totals.counts.unwarranted += 1
    } else {
      totals.mismatchedMinor += amount
      totals.counts.mismatch += 1
    }
  }

  return totals
}

/**
 * Reconciliation grouped by currency, which is the only form that is safe to
 * total.
 *
 * Exists because `totalReconciliation` silently sums whatever it is given, and
 * a merchant selling in two currencies is the ordinary case rather than an edge
 * one. Summing across them is the same class of error the warrant's own
 * denomination check exists to catch.
 */
export function reconcileByUnit(
  rows: readonly WalletTransaction[],
  stallPubkey: string,
): Map<string, ReconciliationTotals> {
  const byUnit = new Map<string, ReconciledIssuance[]>()

  for (const item of reconcileIssuances(rows, stallPubkey)) {
    const unit = item.row.unit
    const bucket = byUnit.get(unit)
    if (bucket) bucket.push(item)
    else byUnit.set(unit, [item])
  }

  const out = new Map<string, ReconciliationTotals>()
  for (const [unit, items] of byUnit) out.set(unit, totalReconciliation(items))
  return out
}


/** One line of a reconciliation summary, ready to render. */
export interface ReconciliationLine {
  unit: string
  /**
   * Where the decimal point goes for this unit.
   *
   * Carried rather than left to the caller, because a renderer that assumes a
   * value would get it wrong for half the estate: EUR 2500 at 0 decimals reads
   * as "€2,500" instead of "€25.00". Taken from the rows themselves, which
   * carry the currency's own decimals.
   */
  decimals: number
  /** Sales the stall can prove it authorised, in minor units. */
  authorisedMinor: number
  /** Of those, how much the customer also attested paying. */
  attestedMinor: number
  /** Sales carrying no usable warrant. */
  unwarrantedMinor: number
  /** Sales whose warrant is present and does not hold. */
  mismatchedMinor: number
  counts: ReconciliationTotals['counts']
  /**
   * Whether anything here needs a human.
   *
   * True only for MISMATCHES. Unwarranted sales are not an alarm - they are
   * every sale issued before warrants shipped, and every sale a terminal made,
   * and raising them all would bury the one row that actually disagrees with
   * its own signature.
   */
  needsAttention: boolean
}

/**
 * A merchant-facing summary of their own issuance history, one line per
 * currency.
 *
 * Separate from `reconcileByUnit` so the screen has a shape it can render
 * directly rather than a Map it has to reduce, and so the "needs attention"
 * judgement lives somewhere testable rather than inside JSX.
 */
export function summariseReconciliation(
  rows: readonly WalletTransaction[],
  stallPubkey: string,
): ReconciliationLine[] {
  const lines: ReconciliationLine[] = []

  // The decimals each unit is actually stored with, so the summary renders in
  // the same shape the rest of the wallet does.
  const decimalsFor = new Map<string, number>()
  for (const row of rows) {
    if (isIssuance(row) && !decimalsFor.has(row.unit)) {
      decimalsFor.set(row.unit, row.decimals)
    }
  }

  for (const [unit, totals] of reconcileByUnit(rows, stallPubkey)) {
    lines.push({
      unit,
      decimals: decimalsFor.get(unit) ?? 0,
      authorisedMinor: totals.authorisedMinor,
      attestedMinor: totals.attestedMinor,
      unwarrantedMinor: totals.unwarrantedMinor,
      mismatchedMinor: totals.mismatchedMinor,
      counts: totals.counts,
      needsAttention: totals.counts.mismatch > 0,
    })
  }

  // Largest authorised first, so the currency a stall actually trades in leads
  // rather than whichever row happened to be stored first.
  return lines.sort((a, b) => b.authorisedMinor - a.authorisedMinor)
}
