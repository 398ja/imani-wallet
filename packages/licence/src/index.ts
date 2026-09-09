/**
 * Verifying a licence: does this voucher unlock anything, for this key, right now?
 *
 * A licence is a voucher we sold. It is P2PK-locked to a key the customer holds,
 * carries an expiry we signed, and names the features it confers. This module
 * answers whether it does — and nothing else.
 *
 * ## Four checks, all local
 *
 * ```
 * K === presenter      the presenter holds the key the voucher is locked to
 * issuer_sig verifies  and the issuer is US, not merely someone
 * expires_at > now     from a clock the caller supplies
 * grant()              which features this licence confers
 * ```
 *
 * No network, no store, no DOM. That is the whole reason this is a package
 * rather than a module in `src/lib`: it makes the check testable at its
 * boundaries — expiry to the second, a wrong signer, a wrong presenter — without
 * a relay, a mint, or a browser (ADR 0007).
 *
 * ## What this module deliberately does not do
 *
 * It does not read a clock. It does not decide what happens when it cannot
 * decide — the grace window is ticket 02 and lives above this. It does not know
 * where a voucher came from or where it is kept. Every one of those is a
 * different question with a different failure mode, and folding them in here is
 * how a verifier becomes untestable.
 */

export type { LicenceVoucher, LicenceGrant, LicenceVerdict, VerifyOptions } from './types.js'
export { DENIAL_REASONS } from './types.js'
export { verifyLicence } from './verify.js'

export type {
  LicenceCheck,
  LastVerification,
  LicenceDecision,
  GraceOptions,
  GraceReason,
} from './grace.js'
export { decideWithGrace, GRACE_REASONS, GRACE_WINDOW_SECONDS } from './grace.js'
