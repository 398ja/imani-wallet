import { allTerminals, type TerminalRecord } from './terminalRoster'
import type { Actor } from './actor'

/**
 * Which terminal handled a movement, on the stall's own records.
 *
 * Terminals ticket 09. An owner reconciling a till at the end of the day needs
 * to know which device took which sale, and needs to answer "who served this
 * customer?" weeks later.
 *
 * ## Attribution is private to the stall
 *
 * It goes on the STALL's copy and never on the coupon. A customer holding a
 * voucher should learn who honours it and nothing about how the stall is
 * staffed — how many tills there are, when a new one appeared, which one was
 * on the door. That is the stall's business, and a coupon travels.
 *
 * This is why attribution lives here rather than in `issue.ts`'s delivery
 * payload: the two are built in the same function, a field added to the wrong
 * one is a one-word mistake, and nothing about the resulting coupon would look
 * wrong.
 *
 * ## The stall's own device is attributed to the stall
 *
 * Not left blank. A blank reads as "unknown", and an owner scanning a day's
 * takings for anomalies should not have to learn that most rows being empty is
 * normal. Every movement has a handler; on the owner's device it is the stall.
 */

/** What the stall's record stores. Absent on the owner's own device. */
export interface TerminalAttribution {
  /** The terminal's public key. Stable across renames, so it is the identity. */
  terminalPubkey: string
}

/**
 * The attribution to store for a movement this actor handled.
 *
 * Returns undefined for an owner, so the record simply has no terminal field
 * rather than one saying "owner" — the stall is the default reading, and
 * `describeHandler` is what turns that absence into words.
 */
export function attributionFor(actor: Actor | undefined | null): TerminalAttribution | undefined {
  if (!actor || actor.kind === 'owner') return undefined
  return { terminalPubkey: actor.terminalPubkey }
}

export const HANDLER = {
  /** The stall itself, on its own device. */
  STALL: 'stall',
  /** A terminal still in service. */
  TERMINAL: 'terminal',
  /** A terminal the owner has since revoked. */
  RETIRED: 'retired',
  /**
   * A terminal key with no roster row.
   *
   * Not the same as the stall. It means the record outlived its terminal's
   * entry — a re-enrolment under a fresh key, or storage cleared — and saying
   * "the stall handled this" would be a claim the data does not support.
   */
  UNKNOWN: 'unknown',
} as const

export type HandlerKind = (typeof HANDLER)[keyof typeof HANDLER]

export interface Handler {
  kind: HandlerKind
  /** What to show. Never empty, whatever the roster does or does not hold. */
  label: string
}

/**
 * Who handled this, in words the owner reads.
 *
 * Takes the roster so a revoked terminal still resolves to its NAME. That is
 * the ticket's fourth criterion: "attribution survives the terminal's
 * revocation, and reads as a terminal no longer in service". Revoking withdraws
 * authority and never erases history, so a movement from six months ago must
 * still say which till took it — and must not imply that till is still trading.
 */
export function describeHandler(
  attribution: TerminalAttribution | undefined | null,
  terminals: readonly TerminalRecord[],
): Handler {
  if (!attribution?.terminalPubkey) {
    return { kind: HANDLER.STALL, label: 'Your device' }
  }

  const row = terminals.find((t) => t.terminalPubkey === attribution.terminalPubkey)

  if (!row) {
    // Named by nothing we hold. Better than inventing a name, and better than
    // silently attributing it to the stall.
    return { kind: HANDLER.UNKNOWN, label: 'A terminal no longer listed' }
  }

  return row.revokedAt === undefined
    ? { kind: HANDLER.TERMINAL, label: row.name }
    : // The name AND its status, because the two answer different questions:
      // which till took this, and can I still go and look at it.
      { kind: HANDLER.RETIRED, label: `${row.name} (no longer in service)` }
}

/** Convenience for a screen that holds only the stall's key. */
export function handlerFor(
  attribution: TerminalAttribution | undefined | null,
  stallPubkey: string,
): Handler {
  return describeHandler(attribution, allTerminals(stallPubkey))
}
