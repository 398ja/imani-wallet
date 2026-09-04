import { grantFor, type TerminalRole } from './terminalRole'
import { mayEnrol, type EnrolDecision } from './terminalAllowance'
import type { LicenceStatus } from './licenceStatus'
import type { TerminalCredential } from './actor'

/**
 * Putting a device on the counter, from the owner's side.
 *
 * Terminals ticket 05. The owner names a terminal, picks its role, scans the
 * code the device is showing, and issues it its authority.
 *
 * ## Why this is a module and not just a screen
 *
 * Three rules have to hold at the moment of enrolment, and two of them are not
 * about the UI at all:
 *
 * 1. **A terminal cannot go live without a role.** The role decides what the
 *    device may do, so a default would be a policy decision made by a form.
 * 2. **Authority is issued for the OWNER's stall and no other.** The stall is
 *    not a field on this screen; it is who the owner is. A screen that took it
 *    as input would be a screen that could grant away someone else's business.
 * 3. **The subscription gate lives here.** Subscriptions ticket 07: "the gate
 *    is at enrolment, on the owner's device, because a terminal cannot exist
 *    without the owner creating it." `terminalAllowance` already decides; this
 *    is where the decision is consulted, at the point of enrolment rather than
 *    by hiding a button.
 *
 * ## What is deliberately NOT here
 *
 * Minting. The credential is a P2PK-locked voucher and the composite
 * `P2PK_VOUCHER` kind is out of scope upstream, so `prepareEnrolment` returns
 * everything the mint call will need and ticket 10 supplies the call. Keeping
 * the decisions here means that ticket adds a network round trip and no rules.
 */

/** What the owner has filled in, before anything is issued. */
export interface EnrolmentRequest {
  /** What the owner calls this terminal, for their own records. */
  name: string
  /** Chosen from the fixed catalog. There is no default — see below. */
  role: TerminalRole | null
  /** The public key scanned off the device's screen. */
  terminalPubkey: string
}

export const ENROLMENT_REFUSAL = {
  NO_NAME: 'no-name',
  NO_ROLE: 'no-role',
  NO_TERMINAL: 'no-terminal',
  /** The stall's own device cannot be enrolled as one of its own terminals. */
  SELF: 'self',
  /** No subscription, and the free allowance is used. */
  NOT_ALLOWED: 'not-allowed',
  OFFLINE: 'offline',
} as const

export type EnrolmentRefusal = (typeof ENROLMENT_REFUSAL)[keyof typeof ENROLMENT_REFUSAL]

export type EnrolmentCheck =
  | { ready: true }
  | { ready: false; reason: EnrolmentRefusal; message: string }

const PUBKEY = /^[0-9a-f]{64}$/

export interface EnrolmentContext {
  /** The owner's stall. Taken from the session, never from the form. */
  stallPubkey: string
  /** What the licence check currently believes. */
  licence: LicenceStatus
  /** Terminals already enrolled, excluding the owner's own device. */
  enrolledCount: number
  /** Whether the device can reach the network. Enrolment needs it. */
  online: boolean
}

/**
 * Can this enrolment go ahead?
 *
 * Every refusal names something the owner can act on, and they are checked in
 * the order an owner would encounter them: what they have not filled in first,
 * then what they are not allowed to do.
 *
 * The subscription refusal is passed through from `mayEnrol` verbatim rather
 * than reworded. That message already names the limit and the contact route,
 * and having two sentences for one situation is how they drift apart.
 */
export function checkEnrolment(
  request: EnrolmentRequest,
  context: EnrolmentContext,
): EnrolmentCheck {
  if (!request.name.trim()) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.NO_NAME,
      message: 'Give this terminal a name, so you can tell your devices apart later.',
    }
  }

  // No default role, deliberately: "a terminal cannot go live without a role"
  // is the ticket's first criterion, and a default would be the app choosing
  // what a device may do.
  if (!request.role) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.NO_ROLE,
      message: 'Choose what this terminal is allowed to do.',
    }
  }

  if (!PUBKEY.test(request.terminalPubkey)) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.NO_TERMINAL,
      message: 'Scan the code showing on the terminal.',
    }
  }

  // The owner's own device is terminal 1 and is counted, not converted. Letting
  // it enrol itself would hand the stall a credential locked to the stall's own
  // key — a second, weaker authority over the same business, and a migration of
  // the one device that needs none.
  if (request.terminalPubkey.toLowerCase() === context.stallPubkey.toLowerCase()) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.SELF,
      message: 'This is your own device. It already trades for your stall and needs no setup.',
    }
  }

  const allowance: EnrolDecision = mayEnrol(context.licence, context.enrolledCount)
  if (!allowance.allowed) {
    return { ready: false, reason: ENROLMENT_REFUSAL.NOT_ALLOWED, message: allowance.message }
  }

  // Last, because it is the only one that might fix itself. Minting needs the
  // mint and there is no degraded path: the spec refuses to pre-issue a stock
  // of unassigned credentials, since those are bearer authorities to the stall
  // sitting in a drawer.
  if (!context.online) {
    return {
      ready: false,
      reason: ENROLMENT_REFUSAL.OFFLINE,
      message:
        'Setting up a terminal needs a connection. Try again when you are back online — ' +
        'terminals are best set up before the market opens.',
    }
  }

  return { ready: true }
}

/**
 * Everything the credential must contain, ready for the mint.
 *
 * Throws rather than returning a partial. `checkEnrolment` is the place that
 * reports problems to a person; reaching here with an invalid request is a
 * programming error, and emitting a half-formed credential would be worse than
 * failing — it would be an authority nobody can account for.
 *
 * The stall comes from the CONTEXT, never the request. That is the ticket's
 * fifth criterion made structural: there is no field in which an owner could
 * name a different stall, so authority cannot be issued for one.
 */
export function prepareEnrolment(
  request: EnrolmentRequest,
  context: EnrolmentContext,
): TerminalCredential & { name: string } {
  const check = checkEnrolment(request, context)
  if (!check.ready) throw new Error(check.message)
  // `checkEnrolment` has established the role; this narrows it for TypeScript.
  if (!request.role) throw new Error('Choose what this terminal is allowed to do.')

  const stall = context.stallPubkey.toLowerCase()

  return {
    name: request.name.trim(),
    stallPubkey: stall,
    role: request.role,
    // Locked to the key the device showed. This is what makes the returned QR
    // safe to observe: it grants nothing to anyone who does not hold `K`.
    lockedTo: request.terminalPubkey.toLowerCase(),
    permissions: grantFor(request.role, stall),
  }
}
