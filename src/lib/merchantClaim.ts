/**
 * What a redemption row must say for the stall's books to count it (#90).
 *
 * ## The defect this closes
 *
 * `issuedVoucher` sums a voucher's claims as incoming rows carrying the SAME
 * `voucherId` as the issuance, and `redemptionLedger` enforces the ceiling off
 * the same rows. The redemption row is written, but not by anything that knows
 * the voucher's id: `tokenRedemption.buildVoucher` takes it from the gateway's
 * receive response (`result.voucher_id || result.id || crypto.randomUUID()`),
 * and `ReceiveResponse` carries neither field. So every redemption landed under
 * a random id, the claimed figure sat at zero, outstanding stayed at the full
 * face, and the ceiling never saw a prior redemption. Nothing failed; the sum
 * ran over an empty set.
 *
 * ## What is stamped, and only when
 *
 * The signed voucher's own id and unit, and the value of THIS token (clamped
 * to the signed face), which dmCrypto puts on `meta` from the verified
 * voucher. A partial redemption therefore records the partial amount and the
 * next one adds to it.
 *
 * Three gates, all load-bearing:
 *
 *  - **Signature verified.** Otherwise every one of these fields is whatever
 *    the sender wrote in the envelope.
 *  - **The receiver is the issuer.** A claim is a coupon coming HOME. A customer
 *    holding someone else's voucher can legitimately receive the same value
 *    more than once (A pays B, B pays A back), and stamping the id there would
 *    switch the ceiling on for them and refuse an honest transfer. Their rows
 *    keep the builder's id, as before.
 *  - **This device issued that voucher, in that unit, and it has room left.**
 *    See below; this is the gate that does the security work.
 *
 * ## What the signature does NOT stop
 *
 * A verified signature means "internally consistent", not "issued by this
 * stall" (`VoucherValidation.signatureValid`): the key it is checked against is
 * carried inside the voucher. Anyone can self-sign a voucher that names this
 * stall as `issuerId` and names ANY `voucherId`, including a real one a
 * customer is still holding, and wrap genuine proofs of this stall in it. A
 * warrant does not help either, since `warrantSaleDigest` does not cover the
 * voucher id. Only a configured issuer allowlist (`checkIssuer` in dmCrypto)
 * refuses such a voucher outright.
 *
 * So the claim is filed only against an `issued` row this device already holds
 * under the same id and unit, and never for more than that issuance has left
 * (`issued.amount` less what is already claimed). A made-up id files nothing,
 * a unit mismatch files nothing, and an inflated face is cut down to the
 * remainder, so claimed can never exceed issued nor outstanding go negative.
 *
 * The residual risk, stated plainly: a forger who knows a live voucher's id
 * can still eat into its remaining figure, and the real holder is then refused
 * at the ceiling. That is bounded by what was issued, needs genuine proofs of
 * this stall, and is closed fully only by the allowlist.
 *
 * ## Unit and decimals
 *
 * The unit is upper-cased and `isClaim` compares units case-insensitively, so
 * a gateway answering "xaf" at issuance still matches a claim stamped "XAF".
 * Decimals come from `currencyDecimals(unit)`, the SAME rule `issue.ts` uses for
 * the issuance row, not from the voucher's signed `face_decimals`: for a
 * merchant's own non-ISO unit `displayDecimals` hands back whatever each row
 * stored, and `isClaim` compares decimals strictly, so two rules would split
 * the claim from its issuance again.
 *
 * ## Terminals file no claim, by design
 *
 * ADR 0005: "A terminal never holds value. A payment request it displays names
 * the stall's own pubkey as recipient, so redeemed coupons are gift-wrapped to
 * the stall and never to `K`." The poller on a terminal receives no coupons,
 * and if one did arrive the receiver would be the terminal's key, not the
 * issuer's, and the terminal holds no `issued` row to file against. The stall's
 * claimed figure is kept by the stall's own device, which is where every
 * redemption lands. The flip side of the issuance gate: a coupon whose
 * `issued` row is not on this device (issued elsewhere, or a history not yet
 * restored) files no claim here. That is refusing rather than guessing, the
 * same "not in my records" limit `reconcileIssuance.saleFor` states.
 *
 * ## Why a local row and not the kind-7377 attestations
 *
 * The attestations are public, so they carry neither the stall nor the amount
 * in the clear, and reading them back means a relay round trip on a till that
 * must enforce its ceiling with no signal. The row is also not device-local:
 * `wallet.backUpWrites` publishes every row written through `atomicallyWrite`
 * as a sealed kind-7376 record, `voucher_id` and `face_value` included, and
 * `restoreTx` reads them back. So the figure survives a restore without making
 * the attestations a second source of truth.
 */
import { currencyDecimals } from './format'
import { isClaim, sameUnit } from './issuedVoucher'
import { repairedTransactions } from './redemptionLedger'
import { isVoucherIssuance, type WalletTransaction } from './transactions'
import type { VoucherValidation } from './voucherToken'

/** What `stampCorrelation` overwrites on the redemption row. */
export interface MerchantClaim {
  voucherId: string
  amount: number
  unit: string
  decimals?: number
  /**
   * The part's value before rounding, stamped as the row's `exactValue` so the
   * next part of the same voucher is credited by cumulative rounding. See
   * `cumulativeCredit` in `@imani/redemption`.
   */
  exact?: number
}

/**
 * The CANDIDATE claim for this redemption, or undefined when there is none.
 *
 * `meta` is dmCrypto's metadata; `stallPubkey` is the receiving wallet's key.
 * Checks only the first two gates. Never stamp this directly: pass it through
 * `boundedClaim` (or use `claimToFile`), which applies the third.
 */
export function merchantClaimFor(
  meta: Record<string, unknown> | undefined,
  stallPubkey: string | undefined,
  /** See `MerchantClaim.exact`. Omitted, the row carries no exact figure. */
  exact?: number,
): MerchantClaim | undefined {
  const validation = meta?.validation as VoucherValidation | undefined
  if (validation?.signatureValid !== true) return undefined

  const issuerId = typeof meta?.issuerId === 'string' ? meta.issuerId : ''
  if (!stallPubkey || !issuerId || issuerId.toLowerCase() !== stallPubkey.toLowerCase()) {
    return undefined
  }

  const voucherId = typeof meta?.voucherId === 'string' ? meta.voucherId : ''
  const amount = Number(meta?.faceValue)
  const unit = typeof meta?.faceUnit === 'string' ? meta.faceUnit.trim().toUpperCase() : ''
  const hasExact = exact !== undefined && Number.isFinite(exact) && exact > 0
  // A zero credit is still filed when there is an exact figure behind it: a
  // part worth half a unit books 0 now and its half carries into the next
  // part's credit, which only works if this row records it.
  if (!voucherId || !unit || !Number.isFinite(amount) || amount < 0) return undefined
  if (amount === 0 && !hasExact) return undefined

  // The issuance rule, not the voucher's signed `face_decimals`. See the module
  // note: `isClaim` compares decimals strictly, and for a non-ISO unit each
  // side's stored value is what it reads back.
  return {
    voucherId,
    amount,
    unit,
    decimals: currencyDecimals(unit),
    ...(hasExact ? { exact } : {}),
  }
}

/**
 * The candidate claim, bound to what this device actually issued.
 *
 * Returns undefined unless `rows` holds an `issued` row under the claim's
 * voucher id in the same unit, and caps the amount at what that issuance has
 * left. Pure, so the gate can be tested without storage. See "What the
 * signature does NOT stop" above for why this is the gate that matters.
 *
 * The decimals are taken from the issuance row when it is found, so the claim
 * cannot disagree with it however that row was written.
 */
export function boundedClaim(
  claim: MerchantClaim | undefined,
  rows: readonly WalletTransaction[],
): MerchantClaim | undefined {
  if (!claim) return undefined

  const issued = rows.find((tx) => isVoucherIssuance(tx) && tx.voucherId === claim.voucherId)
  if (!issued || !sameUnit(issued.unit, claim.unit) || !(issued.amount > 0)) return undefined

  const alreadyClaimed = rows
    .filter((tx) => isClaim(tx, issued))
    .reduce((sum, tx) => sum + (Number.isFinite(tx.amount) ? tx.amount : 0), 0)
  const left = issued.amount - alreadyClaimed
  if (left < 0 || (left === 0 && claim.amount > 0)) return undefined

  return {
    voucherId: claim.voucherId,
    amount: Math.min(claim.amount, left),
    // The issuance's own spelling, so the two rows read identically.
    unit: issued.unit,
    decimals: issued.decimals,
    ...(claim.exact === undefined ? {} : { exact: claim.exact }),
  }
}

/**
 * The claim to stamp on this redemption's row, read against local history.
 *
 * Never throws: a failure to read history files no claim, which leaves the
 * row exactly as it was before #90 rather than blocking a redemption.
 */
export async function claimToFile(
  meta: Record<string, unknown> | undefined,
  stallPubkey: string | undefined,
  exact?: number,
): Promise<MerchantClaim | undefined> {
  const claim = merchantClaimFor(meta, stallPubkey, exact)
  if (!claim) return undefined
  try {
    // The repaired rows, the same ones the ceiling reads (#145): a row another
    // coupon's redeem stamped with this voucher must not eat its remainder.
    const rows = await repairedTransactions()
    return boundedClaim(claim, rows)
  } catch (error) {
    console.warn('[merchantClaim] could not read history; filing no claim', error)
    return undefined
  }
}
