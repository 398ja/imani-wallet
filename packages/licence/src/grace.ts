import { DENIAL_REASONS, type DenialReason, type LicenceGrant, type LicenceVerdict } from './types.js'

/**
 * Twenty-four hours, in SECONDS to match `expiresAt` and `now` everywhere else
 * in this package. Mixing units across a boundary is how a window becomes a
 * thousand times too long without a single test noticing.
 *
 * The number is ADR 0007's, matching NAP extension 0001 §7.1's ceiling for
 * voucher-backed sessions: long enough that a merchant trading daily never sees
 * it, short enough that a lapsed subscription is not a free week.
 */
export const GRACE_WINDOW_SECONDS = 24 * 60 * 60

/**
 * What happened when the app tried to check its licence.
 *
 * The distinction this type exists to force is the whole ticket: an ANSWER and
 * an OUTAGE are not the same event, and code that collapses them into
 * `verdict | null` will either lock a paying merchant out over a dead relay or
 * hand a lapsed one a free day. Neither is recoverable downstream, because by
 * then the reason is gone.
 */
export type LicenceCheck =
  /**
   * The check ran and returned a signed answer — granted or refused. An EXPIRED
   * voucher arrives here, not below: we asked and it said no.
   */
  | { status: 'answered'; verdict: LicenceVerdict }
  /**
   * The check could not run at all: the voucher could not be loaded, storage
   * was unavailable, the delivery has not arrived. Nothing was decided, so
   * there is nothing to obey.
   */
  | { status: 'impossible'; detail: string }

/**
 * The last time a check ANSWERED "granted", and what it granted.
 *
 * The grant is carried rather than re-derived because the window has to keep
 * serving the same features the verification conferred. Re-deriving would mean
 * reading the voucher, which is exactly what is impossible in this branch.
 *
 * `null` means never verified, and that is a real state rather than a missing
 * one: a fresh install has no window. See `NEVER_VERIFIED` below.
 */
export interface LastVerification {
  /** Unix SECONDS, at the moment the check answered. */
  at: number
  grant: LicenceGrant
}

/**
 * Refusals the window itself produces, distinct from the verifier's.
 *
 * Kept separate from `DENIAL_REASONS` rather than merged into it, because those
 * are all statements about a VOUCHER and these are statements about a DEVICE's
 * history. A caller showing "your subscription ended" for `grace-elapsed` would
 * be telling a customer with a perfectly valid licence that they had lapsed.
 */
export const GRACE_REASONS = {
  /** No prior successful verification. Absence of history is not a grace period. */
  NEVER_VERIFIED: 'never-verified',
  /** Verified once, and the window measured from that moment has passed. */
  GRACE_ELAPSED: 'grace-elapsed',
} as const

export type GraceReason = (typeof GRACE_REASONS)[keyof typeof GRACE_REASONS]

export type LicenceDecision =
  | {
      granted: true
      grant: LicenceGrant
      /**
       * `verified` means a check answered yes just now; `grace` means nothing
       * could be checked and the window is carrying it. Surfaced because a UI
       * that cannot tell them apart cannot warn "we have not been able to
       * confirm your subscription" before the window drains — which is the
       * difference between a lapse and a surprise.
       */
      source: 'verified' | 'grace'
      /**
       * When the window stops carrying this, present only under `grace`. Lets a
       * caller show a deadline without re-implementing the arithmetic and
       * getting a different answer than the decision it is describing.
       */
      graceExpiresAt?: number
    }
  | { granted: false; reason: DenialReason | GraceReason; detail: string }

export interface GraceOptions {
  /** The outcome of this attempt: an answer, or an outage. */
  check: LicenceCheck
  /** The last check that ANSWERED yes, or null if there has never been one. */
  lastVerification: LastVerification | null
  /** Now, unix SECONDS, supplied rather than read — clocks are the bug here. */
  now: number
  /** Overridable for a test that wants a window it can step over cheaply. */
  windowSeconds?: number
}

/**
 * Should this device keep its features, given what it was able to check?
 *
 * ADR 0007 fails OPEN here, and only here. A wrongly-granted feature costs a few
 * hours of unpaid access; a wrongly-denied one takes a working till away from a
 * paying merchant mid-trade at a market, over an outage that is ours. Only the
 * second is a real failure, so an outage is survived and an answer is obeyed.
 *
 * Three rules, and the second is the one that is easy to get wrong:
 *
 * 1. **An answer is obeyed, immediately, whichever way it went.** A refusal is
 *    signed — including an expiry, which is not an outage but the product of the
 *    subscription ending on the date we sold. No window softens it.
 * 2. **An outage is survived, but only on credit already earned.** The window
 *    runs from the LAST SUCCESSFUL VERIFICATION, so an app that stays offline
 *    cannot extend it: every second offline is a second of the window spent.
 *    Measuring from install, or from first launch, would make "never connect"
 *    the winning strategy.
 * 3. **No history, no window.** A device that has never verified has earned
 *    nothing, and treating an empty store as a grace period would hand a free
 *    day to anyone who clears their storage.
 *
 * This function reads no clock and touches no storage. Persisting
 * `lastVerification` is a caller's job; deciding is this one's.
 */
export function decideWithGrace(options: GraceOptions): LicenceDecision {
  const { check, lastVerification, now } = options
  const windowSeconds = options.windowSeconds ?? GRACE_WINDOW_SECONDS

  if (check.status === 'answered') {
    const { verdict } = check
    if (verdict.granted) {
      return { granted: true, grant: verdict.grant, source: 'verified' }
    }
    // Every denial reason reaches here unsoftened, deliberately. Filtering to
    // "only EXPIRED locks at once" was rejected: a wrong-key or bad-signature
    // answer is just as signed, and a window over them would let a stolen or
    // forged voucher buy a day by being presented once and then made
    // unreachable.
    return { granted: false, reason: verdict.reason, detail: verdict.detail }
  }

  if (!lastVerification) {
    return {
      granted: false,
      reason: GRACE_REASONS.NEVER_VERIFIED,
      detail: `nothing could be checked (${check.detail}) and this device has never verified a licence`,
    }
  }

  const graceExpiresAt = lastVerification.at + windowSeconds

  /**
   * An expiry we already read is still an answer, even when today's check could
   * not run. The grant remembered from the last verification carries the signed
   * `expiresAt`, so a licence that has since ended locks now rather than
   * lingering for the rest of the window. Without this, going offline just
   * before an expiry would buy a day the customer did not pay for — the one
   * thing ADR 0007 says must NOT fail open.
   */
  if (lastVerification.grant.expiresAt <= now) {
    return {
      granted: false,
      reason: DENIAL_REASONS.EXPIRED,
      detail: `this licence expired at ${lastVerification.grant.expiresAt}`,
    }
  }

  // `>=`, matching the verifier's `<=` on expiry: the boundary instant belongs
  // to the past. A window that granted at exactly its own end would make its
  // last second behave unlike every second before it.
  if (now - lastVerification.at >= windowSeconds) {
    return {
      granted: false,
      reason: GRACE_REASONS.GRACE_ELAPSED,
      detail: `nothing could be checked (${check.detail}) and the grace window ended at ${graceExpiresAt}`,
    }
  }

  // A clock that has moved BACKWARDS lands here, with a negative elapsed time,
  // and is granted. That is the fail-open side of the asymmetry taken
  // literally: a device whose clock is wrong is a device we cannot check, and
  // refusing it would be denying a paying merchant over our own inability. It
  // cannot be milked either, since the remembered expiry above is absolute.
  return {
    granted: true,
    // Copied, so the window cannot hand out a list a caller mutated last time.
    grant: { ...lastVerification.grant, features: [...lastVerification.grant.features] },
    source: 'grace',
    graceExpiresAt,
  }
}
