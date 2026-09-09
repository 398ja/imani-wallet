import { FREE_TERMINALS, type EnrolDecision } from './terminalAllowance'
import { LICENCE_FEATURES } from './licenceIssue'
import { grants, type LicenceStatus } from './licenceStatus'
import type { TerminalRecord } from './terminalRoster'

/**
 * What a lapsed subscription does to terminals that are already out.
 *
 * Subscriptions ticket 08. `terminalAllowance.ts` answers "may another be
 * enrolled"; this answers "which of the ones already enrolled may still serve",
 * and they are different questions with different answers during a lapse.
 *
 * ## A lapse takes tills, never trade
 *
 * This is the module where the design is either kind or punitive. Three things
 * it deliberately does NOT do:
 *
 * - **It revokes nothing.** No credential is burned, no roster row is touched.
 *   Renewal restores service with no re-enrolment, because nothing was undone
 *   in the first place. Revoking on lapse would mean re-enrolling every device
 *   by hand after payment, which punishes someone who just paid.
 * - **It never stops the stall trading.** The owner's own device is not
 *   enrolled and never appears here, so it cannot be stopped by anything in
 *   this file. A billing problem must not close a stall.
 * - **It keeps the free allowance.** A lapsed stall is left exactly where an
 *   unsubscribed one starts, rather than worse off for having once paid.
 *
 * ## Which terminals keep serving is decided by age
 *
 * The free allowance has to land on SOME terminal, and the choice must be
 * stable: a rule that shuffled would stop a different till each time anyone
 * asked, which from behind a counter looks like the app is broken. Oldest
 * enrolment first, because it is the one the stall has been using longest and
 * the one whose sudden death would be most surprising.
 */

export type ServingDecision =
  | { serving: true }
  /** Stopped by a lapse. Nothing was revoked; renewal restores it. */
  | { serving: false; reason: 'lapsed'; message: string }

/**
 * What staff see on a till that a lapse has stopped.
 *
 * On the TERMINAL, which by design never checks a licence and never carries
 * one — so this cannot say "your subscription ended" as a diagnosis. It says
 * the till is not authorised and points at the owner, which is both true from
 * the terminal's point of view and the only action available to whoever is
 * holding it.
 *
 * It also avoids blaming the device. Staff who believe the hardware failed will
 * go looking for a charger instead of the owner.
 */
export const STOPPED_BY_LAPSE_MESSAGE =
  'This till is not authorised to trade right now. Ask the stall owner — it can be turned ' +
  'back on straight away, and nothing has been lost.'

/**
 * The terminals still entitled to serve, oldest enrolment first.
 *
 * Under a live subscription this is every live terminal: the licence is sold
 * per STALL and names no number, so there is no count to apply. Reintroducing
 * one here would be per-terminal pricing arriving by the back door.
 */
export function servingTerminals(
  status: LicenceStatus,
  terminals: readonly TerminalRecord[],
): TerminalRecord[] {
  const live = terminals
    // `filter` already returns a new array, so the sort below cannot reach the
    // caller's roster — which matters, because that roster is what the owner's
    // screen is about to render and reordering it under them would be a bug
    // nobody would think to look for here. A `.slice()` was here to make that
    // safe and was removed: a mutation control showed it changed nothing, and a
    // defensive copy that defends against nothing is a claim that misleads.
    .filter((t) => t.revokedAt === undefined)
    // Ascending, so "oldest first" is what `slice` takes below.
    .sort((a, b) => a.enrolledAt - b.enrolledAt)

  if (grants(status, LICENCE_FEATURES.TERMINALS)) return live

  return live.slice(0, FREE_TERMINALS)
}

/**
 * May this specific terminal still serve?
 *
 * Takes the WHOLE roster, not a count, because the answer depends on where this
 * terminal sits among the others — the free allowance belongs to one of them
 * and it has to be the same one every time.
 *
 * A terminal not in the roster is refused. That is the revoked and the
 * unrecognised case together, and both should stop: an unknown row is not
 * evidence of authority.
 */
export function mayServe(
  status: LicenceStatus,
  terminals: readonly TerminalRecord[],
  terminalPubkey: string,
): ServingDecision {
  const serving = servingTerminals(status, terminals).some(
    (t) => t.terminalPubkey === terminalPubkey,
  )

  return serving
    ? { serving: true }
    : { serving: false, reason: 'lapsed', message: STOPPED_BY_LAPSE_MESSAGE }
}

/**
 * How many terminals a lapse would stop, for a warning the owner sees BEFORE it
 * happens.
 *
 * Exists so the expiry notice can say "2 of your tills will stop" rather than
 * something vague. A number the owner can check against what they can see on
 * the counter is what makes the warning actionable.
 */
export function terminalsStoppedByLapse(
  status: LicenceStatus,
  terminals: readonly TerminalRecord[],
): number {
  const live = terminals.filter((t) => t.revokedAt === undefined).length
  return Math.max(0, live - servingTerminals(status, terminals).length)
}

/** Re-exported so a caller gating a screen reads one import, not two. */
export type { EnrolDecision }
