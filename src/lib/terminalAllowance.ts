import { DENIAL_REASONS, GRACE_REASONS } from '@imani/licence'

import { LICENCE_FEATURES } from './licenceIssue'
import { grants, type LicenceStatus } from './licenceStatus'

/**
 * How many tills a stall may run, and what to say when it may not run another.
 *
 * The subscriptions half of ticket 07. The GATE itself — refusing at the moment
 * the owner tries to enrol — belongs to the terminals enrolment screen, which
 * does not exist yet (terminals 05). This is the rule that screen will ask, put
 * here so it lands with the licence work that defines it rather than being
 * reinvented inside a screen that is really about scanning a QR code.
 *
 * ## One free terminal, and it is the owner's own device
 *
 * "A stall gets one terminal free — their own device, which is what they have
 * today — and the subscription buys the second onwards."
 *
 * The owner's device is COUNTED, not converted. It keeps authenticating as the
 * stall exactly as it does now: it holds the stall's key, it is not enrolled,
 * and it is never asked to be. Making it a real enrolled terminal would be a
 * migration of every existing merchant's device for no benefit they could
 * perceive — so `FREE_TERMINALS` is an allowance against the count of ENROLLED
 * terminals, and the owner's device is the one that does not appear in it.
 *
 * ## The count is client-side, and that is accepted
 *
 * ADR 0007 already says the gate stops honest customers rather than determined
 * ones. A server-side count would unpick the decision that makes terminals
 * cheap — the gateway deliberately does not learn a stall's terminals exist —
 * and cryptographic enrolment tokens would add a credential lifecycle to
 * recover a small amount of revenue leakage. A merchant technical enough to
 * patch the client is not the customer whose loss is worth that complexity.
 *
 * ## A lapse suspends; it never revokes
 *
 * `mayEnrol` refuses while lapsed, and that is ALL it does. Nothing here burns
 * a credential or deletes a terminal, because renewal has to restore service
 * instantly — the whole reason the two vouchers are separate. What a lapse does
 * to terminals ALREADY running is ticket 08, and it needs the terminal list
 * that terminals 06 will build.
 */

/**
 * Terminals a stall may run without a subscription.
 *
 * One, and it is not enrolled — see above. A number rather than a boolean
 * because the refusal has to say "you have 1 and 1 is your limit", and a
 * caller that only knew `false` could not.
 */
export const FREE_TERMINALS = 1

export const ENROL_REFUSAL = {
  /** Already at the free allowance, with no subscription. */
  AT_FREE_LIMIT: 'at-free-limit',
  /** Had a subscription; it ended. Renewing restores this immediately. */
  LAPSED: 'lapsed',
} as const

export type EnrolRefusal = (typeof ENROL_REFUSAL)[keyof typeof ENROL_REFUSAL]

export type EnrolDecision =
  | { allowed: true }
  | { allowed: false; reason: EnrolRefusal; message: string }

/**
 * May this stall enrol another terminal?
 *
 * `enrolledCount` is the number of ENROLLED terminals, excluding the owner's
 * own device. A stall that has never enrolled anything passes 0 and is allowed
 * one; that first enrolment is the free one.
 *
 * The distinction between the two refusals is not cosmetic. "You have reached
 * your free terminal" and "your subscription ended" send a merchant to
 * completely different actions — buy, versus renew — and a gate that could only
 * say "no" would send them nowhere.
 */
export function mayEnrol(status: LicenceStatus, enrolledCount: number): EnrolDecision {
  if (grants(status, LICENCE_FEATURES.TERMINALS)) {
    // A live subscription. The spec sells per STALL, not per terminal:
    // "One voucher, however many terminals." So there is no count to check —
    // per-terminal pricing was rejected precisely because it is not enforceable
    // here, and re-introducing a numeric cap would be that decision reversed by
    // accident.
    return { allowed: true }
  }

  if (enrolledCount < FREE_TERMINALS) {
    return { allowed: true }
  }

  // No subscription now. WAS there one? A stall that has held a licence and let
  // it lapse gets a different sentence from one that never subscribed, because
  // renewing and buying are different acts.
  //
  // `status.licence` alone is NOT enough to tell them apart. It is null whenever
  // the voucher could not be READ, and the case that matters is a subscriber
  // whose device is offline past its grace window: `grace-elapsed`, with no
  // licence in hand. Keying on the licence would tell a paying customer to buy
  // something they already own, at the worst possible moment.
  //
  // So the REASON decides, and only two of them mean "never subscribed":
  //
  //   absent          the store was readable and held no licence
  //   never-verified  nothing could be read, and this device has never verified
  //
  // Every other refusal — expired, grace-elapsed, and the tamper reasons — is a
  // device that has, at some point, held something we issued.
  //
  // Narrowed explicitly rather than reading `status.decision.reason` directly:
  // `LicenceDecision` is a union, and `reason` only exists on the refusing arm.
  // TypeScript is right to insist — the granted case is handled above and can
  // never reach here, but saying so is what keeps that true if the order above
  // ever changes.
  const decision = status.decision
  const neverSubscribed =
    !decision.granted &&
    (decision.reason === DENIAL_REASONS.ABSENT ||
      decision.reason === GRACE_REASONS.NEVER_VERIFIED)

  return neverSubscribed
    ? {
        allowed: false,
        reason: ENROL_REFUSAL.AT_FREE_LIMIT,
        message:
          `You are using your free till. Running more than ${FREE_TERMINALS} at once ` +
          'needs a subscription — get in touch and we will set one up. ' +
          'This device is not affected and keeps working as it does now.',
      }
    : {
        allowed: false,
        reason: ENROL_REFUSAL.LAPSED,
        message:
          'Your subscription has ended, so you cannot add another till. ' +
          'Renewing restores your tills straight away — get in touch and we will sort it out. ' +
          'Your stall keeps trading either way.',
      }
}

/**
 * How many more terminals may be enrolled right now, for a screen that wants to
 * say so before the owner starts.
 *
 * `Infinity` under a live subscription, which is the honest answer: the licence
 * is per stall and names no number. A screen should show "unlimited" rather
 * than invent a ceiling — and a caller that compares against it still behaves
 * correctly, which is why this is not `-1` or `null`.
 *
 * This is INFORMATION, and `mayEnrol` remains the gate. A screen that hid the
 * button using this number and skipped the check would be exactly the "hiding a
 * button" the ticket refuses: the refusal must happen at enrolment, where
 * someone who navigated straight to it still meets it.
 */
export function remainingTerminals(status: LicenceStatus, enrolledCount: number): number {
  if (grants(status, LICENCE_FEATURES.TERMINALS)) return Infinity
  return Math.max(0, FREE_TERMINALS - enrolledCount)
}
