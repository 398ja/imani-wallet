import { roleOf, type TerminalRole } from './terminalRole'

/**
 * The stall's record of the terminals it has out, and withdrawing one.
 *
 * Terminals ticket 06, kept on the OWNER's device. There is deliberately no
 * server-side list: ADR 0005 removes the per-terminal record on the gateway,
 * which is what makes terminals cheap, so the owner's own copy is the only
 * roster there is.
 *
 * ## Revocation must work with the device gone
 *
 * The lost, stolen and dead-battery cases are the only ones that really matter,
 * so nothing here asks the terminal for anything. The owner keeps what is
 * needed to spend each terminal's proof (`revocationSecret`), which is why
 * revoking a device at the bottom of a river is the same operation as revoking
 * one on the counter.
 *
 * ## Revoking withdraws authority; it never erases
 *
 * A revoked terminal stays in the roster, marked. Its past movements stay in
 * the stall's records attributed to it — "revoking is not the same as erasing"
 * is a user story, and a stall that lost its own history every time it retired
 * a till could not reconcile anything.
 *
 * ## There is no pause
 *
 * The mint models spent, not suspended, so this module offers `revoke` and
 * nothing else. A `suspend` here would need exactly the server-side record the
 * design removes, and an owner who wants a terminal back enrols it again —
 * seconds of work. The absence is the feature.
 */

/** How long a session may outlive its credential. ADR 0005 sets 12 hours. */
export const REVOCATION_DELAY_HOURS = 12

/**
 * What the screen says about the delay, rather than leaving it to be found out.
 *
 * The fourth acceptance criterion is that this is STATED. An owner who has just
 * lost a device is deciding whether to also close the stall, and they cannot
 * make that decision against a number nobody told them.
 */
export const REVOCATION_DELAY_NOTE =
  `A revoked terminal stops trading within ${REVOCATION_DELAY_HOURS} hours, when its ` +
  'session next expires. If the device is in the wrong hands and that is too long, ' +
  'close your stall as well.'

export interface TerminalRecord {
  /** This terminal's own public key. The roster's identity for it. */
  terminalPubkey: string
  /** What the owner called it. */
  name: string
  role: TerminalRole
  enrolledAt: number
  /** Epoch ms of the last movement this terminal handled, if any. */
  lastUsedAt?: number
  /**
   * What the owner needs to spend this terminal's proof.
   *
   * Retained at enrolment so revocation never needs the device — the third
   * acceptance criterion, and the reason revocation is safe at all.
   */
  revocationSecret?: string
  /** Set when revoked. Present means retired; the record itself stays. */
  revokedAt?: number
}

const ROSTER_KEY = (stallPubkey: string) => `imani-wallet:terminals:${stallPubkey}`

function read(stallPubkey: string): TerminalRecord[] {
  try {
    const raw = localStorage.getItem(ROSTER_KEY(stallPubkey))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    // Each record is validated rather than cast. A roster row with an unknown
    // role would otherwise render as a terminal whose powers nobody can state.
    return parsed.flatMap((entry): TerminalRecord[] => {
      const row = entry as Partial<TerminalRecord>
      const role = roleOf(row.role)
      if (!role || typeof row.terminalPubkey !== 'string') return []
      return [
        {
          terminalPubkey: row.terminalPubkey,
          name: typeof row.name === 'string' ? row.name : 'Terminal',
          role,
          enrolledAt: typeof row.enrolledAt === 'number' ? row.enrolledAt : 0,
          lastUsedAt: typeof row.lastUsedAt === 'number' ? row.lastUsedAt : undefined,
          revocationSecret:
            typeof row.revocationSecret === 'string' ? row.revocationSecret : undefined,
          revokedAt: typeof row.revokedAt === 'number' ? row.revokedAt : undefined,
        },
      ]
    })
  } catch {
    return []
  }
}

function write(stallPubkey: string, rows: TerminalRecord[]): void {
  try {
    localStorage.setItem(ROSTER_KEY(stallPubkey), JSON.stringify(rows))
  } catch {
    // Storage refused. The caller has already issued the credential, so losing
    // the roster row costs the owner their list, not the terminal its authority.
  }
}

/** Everything this stall has ever enrolled, newest first. */
export function allTerminals(stallPubkey: string): TerminalRecord[] {
  return read(stallPubkey).sort((a, b) => b.enrolledAt - a.enrolledAt)
}

/**
 * The terminals currently out.
 *
 * What the list shows by default. A revoked terminal is not "out" — showing it
 * alongside live ones would make the roster a history rather than an answer to
 * "what is trading for me right now".
 */
export function liveTerminals(stallPubkey: string): TerminalRecord[] {
  return allTerminals(stallPubkey).filter((t) => t.revokedAt === undefined)
}

/**
 * How many terminals count against the free allowance.
 *
 * The number `mayEnrol` takes. Revoked terminals are NOT counted: a stall that
 * retired a till has not used up its allowance on a device that no longer
 * trades, and counting them would make revocation a punishment.
 */
export function enrolledCount(stallPubkey: string): number {
  return liveTerminals(stallPubkey).length
}

/** Record a terminal the owner has just enrolled. */
export function recordTerminal(stallPubkey: string, record: TerminalRecord): void {
  const rows = read(stallPubkey).filter((t) => t.terminalPubkey !== record.terminalPubkey)
  write(stallPubkey, [...rows, record])
}

/** Note that a terminal handled something, for the "last used" column. */
export function noteTerminalUse(stallPubkey: string, terminalPubkey: string, at: number): void {
  const rows = read(stallPubkey)
  const row = rows.find((t) => t.terminalPubkey === terminalPubkey)
  if (!row) return
  row.lastUsedAt = at
  write(stallPubkey, rows)
}

export type RevokeOutcome =
  | { revoked: true; record: TerminalRecord }
  | { revoked: false; reason: 'unknown' | 'already-revoked' }

/**
 * Withdraw a terminal's authority.
 *
 * MARKS rather than deletes, which is the fifth acceptance criterion: the
 * stall's records keep pointing at a terminal that existed, and a movement from
 * six months ago can still be attributed to the till that handled it.
 *
 * Takes no argument about the device and makes no call to it. That is the point
 * — the owner holds `revocationSecret` from enrolment, so a device that is
 * lost, stolen, flat or destroyed is revoked exactly like one on the counter.
 *
 * Idempotent in the direction that matters: revoking twice reports
 * `already-revoked` rather than moving the timestamp, so an owner who taps
 * twice does not extend the window they were told about.
 */
export function revokeTerminal(
  stallPubkey: string,
  terminalPubkey: string,
  at: number = Date.now(),
): RevokeOutcome {
  const rows = read(stallPubkey)
  const row = rows.find((t) => t.terminalPubkey === terminalPubkey)

  if (!row) return { revoked: false, reason: 'unknown' }
  if (row.revokedAt !== undefined) return { revoked: false, reason: 'already-revoked' }

  row.revokedAt = at
  write(stallPubkey, rows)
  return { revoked: true, record: row }
}

/**
 * Is this terminal still authorised by its stall, as the OWNER sees it?
 *
 * The owner's view, not the terminal's. A revoked terminal keeps working until
 * its session expires — up to `REVOCATION_DELAY_HOURS` — which is precisely why
 * the delay is stated on screen rather than implied by this returning false.
 */
export function isRevoked(stallPubkey: string, terminalPubkey: string): boolean {
  const row = read(stallPubkey).find((t) => t.terminalPubkey === terminalPubkey)
  return row?.revokedAt !== undefined
}

/**
 * When a revoked terminal is expected to stop trading.
 *
 * Derived so a screen can show a time rather than repeat the policy, and so the
 * number in the sentence and the number on the row cannot disagree.
 */
export function revocationBitesAt(record: TerminalRecord): number | null {
  return record.revokedAt === undefined
    ? null
    : record.revokedAt + REVOCATION_DELAY_HOURS * 3600 * 1000
}
