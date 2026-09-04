import { REVOCATION_DELAY_HOURS } from './terminalRoster'
import { mayIssue, mayRedeem, type Actor, type TerminalActor } from './actor'
import { TERMINAL_ACTIONS, permissionFor } from './terminalRole'

/**
 * A terminal's trading session: how long it lasts, and what it can still do.
 *
 * Terminals ticket 07. The credential says what a terminal is ALLOWED to do;
 * the session says what it can do RIGHT NOW, and the two differ in exactly the
 * cases staff actually hit — the day has rolled over, the authority was
 * withdrawn, or the mint could not be reached at login.
 *
 * ## Why a ceiling exists at all
 *
 * ADR 0005 keeps no per-terminal record on the gateway, so there is nothing to
 * poll for "has this been revoked". The session's own expiry is what makes
 * revocation bite: a session lasts at most one trading day, so a terminal
 * re-authenticates when it opens and never mid-shift, and a revoked terminal is
 * dead by the end of trading. That is the same twelve hours the owner's
 * revocation screen quotes, imported rather than restated so the promise made
 * to the owner and the behaviour on the terminal cannot drift apart.
 *
 * ## Reduced authority is redemption only
 *
 * When the mint is unreachable a session may still open, carrying redemption
 * but not issuance. A queue at a stall cannot wait for the network to agree,
 * and redemption must never need the network to authorise. Issuance does wait,
 * because it is value-bearing: a coupon issued on an authority nobody could
 * check is money created on a guess.
 */

/** One trading day. The same number the owner is shown when they revoke. */
export const SESSION_HOURS = REVOCATION_DELAY_HOURS

/** How a session was opened, which is what decides its authority. */
export const SESSION_KIND = {
  /** The mint answered. The terminal has everything its role allows. */
  FULL: 'full',
  /** The mint was unreachable. Redemption only, however senior the role. */
  REDUCED: 'reduced',
} as const

export type SessionKind = (typeof SESSION_KIND)[keyof typeof SESSION_KIND]

export interface TerminalSession {
  actor: TerminalActor
  kind: SessionKind
  openedAt: number
  /** Never later than `openedAt + SESSION_HOURS`. See `openSession`. */
  expiresAt: number
}

/**
 * Open a session for an enrolled terminal.
 *
 * The ceiling is applied here rather than trusted from a caller, so there is no
 * argument that could extend a session past one trading day. A credential that
 * claimed a longer life would be capped, which is the point: the bound is ours,
 * not the credential's.
 */
export function openSession(
  actor: TerminalActor,
  kind: SessionKind,
  openedAt: number = Date.now(),
): TerminalSession {
  return {
    actor,
    kind,
    openedAt,
    expiresAt: openedAt + SESSION_HOURS * 3600 * 1000,
  }
}

export const LAPSE = {
  /** The trading day rolled over. The ordinary case, and not a problem. */
  EXPIRED: 'expired',
  /** The owner withdrew this terminal's authority. */
  REVOKED: 'revoked',
  /** The stored credential no longer checks out. Tampering, or corruption. */
  INVALID: 'invalid',
} as const

export type LapseReason = (typeof LAPSE)[keyof typeof LAPSE]

export type SessionState =
  | { live: true; session: TerminalSession }
  | { live: false; reason: LapseReason; message: string }

/**
 * What a lapsed terminal says, in words for whoever is holding it.
 *
 * Staff, not the owner, and usually mid-queue. Each one names what happened and
 * what to do about it, because "say so once and stop offering to serve" is
 * useless if the sentence leaves somebody guessing whether to retry.
 *
 * Expiry is deliberately not phrased as a fault. It happens every single day to
 * every terminal, and an alarming message for the most routine event in the
 * system would teach staff to ignore all of them.
 */
export const LAPSE_MESSAGE: Record<LapseReason, string> = {
  [LAPSE.EXPIRED]: 'This terminal needs signing in again for today’s trading. Ask the stall owner.',
  [LAPSE.REVOKED]: 'This terminal is no longer in service. Ask the stall owner to set it up again.',
  [LAPSE.INVALID]:
    'This terminal has lost its authority to trade. Ask the stall owner to set it up again.',
}

/**
 * Is this session still good?
 *
 * Returns the REASON, not just a boolean, because the three cases mean
 * genuinely different things to whoever is holding the device: one needs the
 * owner to open the stall, one means the device has been retired, and one means
 * something is wrong. A single "cannot trade" would collapse them into a shrug.
 */
export function sessionState(
  session: TerminalSession | null,
  { revoked = false, now = Date.now() }: { revoked?: boolean; now?: number } = {},
): SessionState {
  if (!session) {
    return { live: false, reason: LAPSE.INVALID, message: LAPSE_MESSAGE[LAPSE.INVALID] }
  }

  // Revocation is checked BEFORE expiry. Both end trading, but a revoked
  // terminal must never be told "sign in again for today" — that is an
  // instruction to do the one thing the owner has just prevented.
  if (revoked) {
    return { live: false, reason: LAPSE.REVOKED, message: LAPSE_MESSAGE[LAPSE.REVOKED] }
  }

  if (now >= session.expiresAt) {
    return { live: false, reason: LAPSE.EXPIRED, message: LAPSE_MESSAGE[LAPSE.EXPIRED] }
  }

  return { live: true, session }
}

/**
 * May this actor issue, given the session it is holding?
 *
 * The session-aware counterpart to `actor.ts`'s `mayIssue`, and the ONLY thing
 * screens should ask. `mayIssue` answers "does the role allow it", which is
 * still true of a terminal whose session died an hour ago.
 *
 * An owner has no session and is unaffected — "a stall on its own device sees
 * no change" is the ticket's fifth criterion, and it holds because the owner
 * path never acquires a session to lapse.
 */
export function canIssueNow(actor: Actor, session: TerminalSession | null): boolean {
  if (actor.kind === 'owner') return mayIssue(actor)
  if (!sessionState(session).live) return false
  // Reduced authority carries redemption and NOT issuance, whatever the role
  // permits. Issuing on an authority nobody could check is money created on a
  // guess, and unlike a redemption it cannot be reconciled away afterwards.
  if (session?.kind === SESSION_KIND.REDUCED) return false
  return mayIssue(actor)
}

/**
 * May this actor redeem, given the session it is holding?
 *
 * Deliberately survives a REDUCED session: the queue cannot wait for the
 * network to agree, and a redemption that turns out to be wrong is recoverable
 * in a way that issued money is not.
 *
 * It does NOT survive a lapsed one. Reduced authority is a working session with
 * less power; a lapsed session is not a session.
 */
export function canRedeemNow(actor: Actor, session: TerminalSession | null): boolean {
  if (actor.kind === 'owner') return mayRedeem(actor)
  if (!sessionState(session).live) return false
  return mayRedeem(actor)
}

/**
 * The permission a request would have to carry, for a refusal to be honest.
 *
 * Exposed so the enforcement point and the screen ask the same question of the
 * same data. "The hiding is the courtesy, not the control" only holds if the
 * control exists, and it only stays true if both halves read one source.
 */
export function issuePermissionFor(stallPubkey: string): string {
  return permissionFor(TERMINAL_ACTIONS.ISSUE, stallPubkey)
}
