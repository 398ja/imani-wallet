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
 * so nothing here asks the terminal for anything. The owner keeps each
 * terminal's credential `token`, which carries the stall as a co-spender
 * (#160, spec 4.3), so revoking a device at the bottom of a river is the same
 * operation as revoking one on the counter: the stall spends the credential.
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
   * The credential itself (#160). The stall is its co-spender, so this is what
   * revoking spends. Kept at enrolment so revocation never needs the device.
   *
   * Absent on rows set up before revocation existed: those were minted by hand,
   * locked to the device alone, and cannot be revoked from here.
   */
  token?: string
  /** The credential's voucher id, which the device's enrolled DM names. */
  voucherId?: string
  /** Epoch ms after which a still-waiting row is cancelled (decision 4: 24 hours). */
  waitingUntil?: number
  /** Set when revoked. Present means retired; the record itself stays. */
  revokedAt?: number
  /**
   * Where setup stands, #160.
   *
   * `waiting`: added on this phone, not yet confirmed by the device, so it
   * cannot trade and the list must not say it can. Absent on rows written
   * before this field existed, which read as they always did.
   */
  status?: TerminalStatus
}

export type TerminalStatus = 'waiting' | 'in-service'

function statusOf(value: unknown): TerminalStatus | undefined {
  return value === 'waiting' || value === 'in-service' ? value : undefined
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
          token: typeof row.token === 'string' ? row.token : undefined,
          voucherId: typeof row.voucherId === 'string' ? row.voucherId : undefined,
          waitingUntil: typeof row.waitingUntil === 'number' ? row.waitingUntil : undefined,
          revokedAt: typeof row.revokedAt === 'number' ? row.revokedAt : undefined,
          status: statusOf(row.status),
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
  // Waiting rows do NOT count against the free terminal (decision 4 on #160):
  // a botched setup must never block the owner from trying again. They are
  // bounded instead, by `MAX_WAITING` and the 24-hour expiry.
  return liveTerminals(stallPubkey).filter((t) => t.status !== 'waiting').length
}

/** At most this many terminals may wait for their device at once (decision 4). */
export const MAX_WAITING = 2

/** How long a waiting row lives before it is cancelled (decision 4). */
export const WAITING_TTL_MS = 24 * 3600 * 1000

/** Unrevoked rows still waiting for their device, oldest first. */
export function waitingTerminals(stallPubkey: string): TerminalRecord[] {
  return liveTerminals(stallPubkey)
    .filter((t) => t.status === 'waiting')
    .sort((a, b) => a.enrolledAt - b.enrolledAt)
}

/** Waiting rows past their 24 hours, which the owner's wallet must cancel. */
export function expiredWaiting(stallPubkey: string, now: number = Date.now()): TerminalRecord[] {
  return waitingTerminals(stallPubkey).filter(
    (t) => (t.waitingUntil ?? t.enrolledAt + WAITING_TTL_MS) <= now,
  )
}

/** Whether a row holds what revoking needs. Rows set up by hand before #160 do not. */
export function isRevocable(record: TerminalRecord): boolean {
  return typeof record.token === 'string' && record.token.length > 0
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
 * — the owner holds the credential `token` from enrolment, so a device that is
 * lost, stolen, flat or destroyed is revoked exactly like one on the counter.
 *
 * This only MARKS the row. Since #160 a caller marks it only after the spend at
 * the mint landed (`revokeTerminalAtMint`).
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
