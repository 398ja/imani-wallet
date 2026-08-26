import type { VoucherValidation } from './voucherToken'
import type { WalletTransaction } from './transactions'

/**
 * What the wallet checked about a coupon, as one status.
 *
 * ONE definition, because the list badge and the detail page are two views of
 * the same fact and a user who sees an amber dot then opens the row expects the
 * page to agree. Two independent readings of `validation` is how they drift.
 *
 * The three states are deliberately not a score:
 *
 *  - `verified` — the issuer's BIP-340 signature checked out over the canonical
 *    bytes. This is the only state that is a positive claim.
 *  - `unchecked` — nothing was verified. Either the row predates verification or
 *    the coupon carried no issuer claim (plain ecash). It is NOT a pass, and it
 *    is NOT a failure; saying either would be a lie in one direction or the
 *    other.
 *  - `failed` — a signature was present and did not verify, or the derived value
 *    exceeded what was signed and had to be clamped. Something is wrong with
 *    this coupon.
 *
 * `legacyCanonical` is deliberately not a state. It is true for every voucher
 * issued to date, so surfacing it would paint the entire existing estate amber
 * and tell a merchant at a stall nothing they can act on.
 */
export type ValidationStatus = 'verified' | 'unchecked' | 'failed'

/**
 * Whether a row makes any claim worth checking.
 *
 * An outgoing row is this wallet's own act — there is no counterparty claim to
 * verify — and plain ecash carries no issuer signature at all. Neither gets a
 * badge, because a grey dot on every payment you ever made is noise that trains
 * people to ignore the ones that matter.
 */
export function hasValidationClaim(tx: WalletTransaction): boolean {
  return tx.direction === 'in' && tx.voucherId !== undefined
}

/** The single reading of a coupon's checks. */
export function validationStatus(v: VoucherValidation | undefined): ValidationStatus {
  if (!v) return 'unchecked'
  if (!v.signatureValid) return 'failed'
  // A clamped value means the derived amount exceeded what the issuer signed,
  // which on a legacy voucher is what a rewritten `issuance_ratio` looks like.
  // The signature verified, so this is not forgery — but the coupon is not what
  // it claimed to be worth, and that is worth a red dot rather than a green one.
  if (v.cappedAtFaceValue) return 'failed'
  return 'verified'
}

/**
 * One short line, for the badge's accessible name and its tooltip.
 *
 * Written for a merchant at a stall with a queue: what it is, in the fewest
 * words that are still true.
 */
export const VALIDATION_SUMMARY: Record<ValidationStatus, string> = {
  verified: 'Issuer signature verified',
  unchecked: 'Not checked',
  failed: 'Check failed',
}
