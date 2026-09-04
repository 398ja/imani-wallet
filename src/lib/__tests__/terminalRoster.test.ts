/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest'

import {
  REVOCATION_DELAY_HOURS,
  REVOCATION_DELAY_NOTE,
  allTerminals,
  enrolledCount,
  isRevoked,
  liveTerminals,
  noteTerminalUse,
  recordTerminal,
  revocationBitesAt,
  revokeTerminal,
  type TerminalRecord,
} from '../terminalRoster'
import { TERMINAL_ROLES } from '../terminalRole'

/**
 * The owner's roster.
 *
 * The properties worth asserting are what revocation does NOT do: it does not
 * need the device, it does not erase history, and it does not offer a way back
 * that isn't re-enrolment.
 */

const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)
const DOOR = 'c'.repeat(64)
const COUNTER = 'd'.repeat(64)
const HOUR = 3600 * 1000

function terminal(over: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    terminalPubkey: DOOR,
    name: 'Door',
    role: TERMINAL_ROLES.REDEEM_ONLY,
    enrolledAt: 1_000_000,
    revocationSecret: 'secret-for-door',
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('the list of what is out', () => {
  it('shows name, role and last use', () => {
    recordTerminal(STALL, terminal({ lastUsedAt: 2_000_000 }))

    const [row] = liveTerminals(STALL)
    expect(row.name).toBe('Door')
    expect(row.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(row.lastUsedAt).toBe(2_000_000)
  })

  it('tracks use without the owner touching the record', () => {
    recordTerminal(STALL, terminal())
    noteTerminalUse(STALL, DOOR, 5_000_000)

    expect(liveTerminals(STALL)[0].lastUsedAt).toBe(5_000_000)
  })

  it('keeps one stall’s terminals out of another’s list', () => {
    recordTerminal(STALL, terminal())
    recordTerminal(OTHER_STALL, terminal({ terminalPubkey: COUNTER, name: 'Not mine' }))

    expect(liveTerminals(STALL).map((t) => t.name)).toEqual(['Door'])
  })

  it('does not duplicate a terminal that is re-recorded', () => {
    // Re-enrolling a replacement device under the same key is one terminal, not
    // two rows the owner has to work out the difference between.
    recordTerminal(STALL, terminal())
    recordTerminal(STALL, terminal({ name: 'Door (replaced)' }))

    expect(liveTerminals(STALL)).toHaveLength(1)
    expect(liveTerminals(STALL)[0].name).toBe('Door (replaced)')
  })

  it('drops a row whose role it cannot state', () => {
    // A roster row with an unknown role would render as a terminal whose powers
    // nobody can name — worse than not showing it.
    localStorage.setItem(
      `imani-wallet:terminals:${STALL}`,
      JSON.stringify([{ terminalPubkey: DOOR, name: 'Odd', role: 'owner', enrolledAt: 1 }]),
    )
    expect(liveTerminals(STALL)).toEqual([])
  })

  it('reads unusable storage as an empty roster rather than throwing', () => {
    for (const bad of ['not json', '{}', 'null']) {
      localStorage.setItem(`imani-wallet:terminals:${STALL}`, bad)
      expect(liveTerminals(STALL)).toEqual([])
    }
  })
})

describe('revoking', () => {
  it('works with the device absent, unreachable or destroyed', () => {
    /**
     * The third criterion, and the whole reason revocation is safe. Nothing in
     * this call reaches the terminal — the owner holds what is needed from
     * enrolment — so a device at the bottom of a river revokes exactly like one
     * on the counter.
     */
    recordTerminal(STALL, terminal())

    const outcome = revokeTerminal(STALL, DOOR, 9_000_000)

    expect(outcome.revoked).toBe(true)
    expect(isRevoked(STALL, DOOR)).toBe(true)
  })

  it('takes the terminal out of the live list', () => {
    recordTerminal(STALL, terminal())
    recordTerminal(STALL, terminal({ terminalPubkey: COUNTER, name: 'Counter' }))

    revokeTerminal(STALL, DOOR)

    expect(liveTerminals(STALL).map((t) => t.name)).toEqual(['Counter'])
  })

  it('never erases: the record stays, marked', () => {
    // "Revoking is not the same as erasing." A stall that lost its history
    // every time it retired a till could not reconcile anything.
    recordTerminal(STALL, terminal())
    revokeTerminal(STALL, DOOR, 9_000_000)

    const kept = allTerminals(STALL).find((t) => t.terminalPubkey === DOOR)
    expect(kept).toBeDefined()
    expect(kept!.name).toBe('Door')
    expect(kept!.revokedAt).toBe(9_000_000)
  })

  it('does not move the deadline when an owner taps twice', () => {
    // An owner has been told when it bites; a second tap must not extend that.
    recordTerminal(STALL, terminal())
    revokeTerminal(STALL, DOOR, 9_000_000)

    const second = revokeTerminal(STALL, DOOR, 9_999_999)

    expect(second.revoked).toBe(false)
    if (!second.revoked) expect(second.reason).toBe('already-revoked')
    expect(allTerminals(STALL)[0].revokedAt).toBe(9_000_000)
  })

  it('reports an unknown terminal rather than silently succeeding', () => {
    const outcome = revokeTerminal(STALL, COUNTER)
    expect(outcome.revoked).toBe(false)
    if (!outcome.revoked) expect(outcome.reason).toBe('unknown')
  })

  it('cannot revoke another stall’s terminal', () => {
    recordTerminal(OTHER_STALL, terminal())
    expect(revokeTerminal(STALL, DOOR).revoked).toBe(false)
    expect(isRevoked(OTHER_STALL, DOOR)).toBe(false)
  })
})

describe('the delay is stated, not discovered', () => {
  it('names the number of hours in words the owner reads', () => {
    // The fourth criterion. An owner deciding whether to also close the stall
    // cannot decide against a number nobody told them.
    expect(REVOCATION_DELAY_NOTE).toContain(String(REVOCATION_DELAY_HOURS))
    expect(REVOCATION_DELAY_NOTE).toMatch(/close your stall/)
  })

  it('derives the deadline, so the sentence and the row cannot disagree', () => {
    recordTerminal(STALL, terminal())
    revokeTerminal(STALL, DOOR, 9_000_000)

    const row = allTerminals(STALL)[0]
    expect(revocationBitesAt(row)).toBe(9_000_000 + REVOCATION_DELAY_HOURS * HOUR)
  })

  it('has no deadline for a terminal still in service', () => {
    recordTerminal(STALL, terminal())
    expect(revocationBitesAt(liveTerminals(STALL)[0])).toBeNull()
  })
})

describe('the free allowance', () => {
  it('counts only terminals still out', () => {
    recordTerminal(STALL, terminal())
    recordTerminal(STALL, terminal({ terminalPubkey: COUNTER, name: 'Counter' }))
    expect(enrolledCount(STALL)).toBe(2)

    // Retiring a till gives the allowance back: counting revoked terminals
    // would make revocation a punishment.
    revokeTerminal(STALL, DOOR)
    expect(enrolledCount(STALL)).toBe(1)
  })
})

describe('there is no pause', () => {
  it('offers revoke and nothing that suspends', async () => {
    /**
     * The sixth criterion, asserted over the module's own surface. A `suspend`
     * or `resume` here would need exactly the server-side record ADR 0005
     * removes, and the absence is the feature — so it is worth failing a build
     * over rather than trusting a review to notice.
     */
    const roster = await import('../terminalRoster')

    for (const banned of ['pause', 'resume', 'suspend', 'disable', 'unrevoke']) {
      expect(Object.keys(roster).some((k) => k.toLowerCase().includes(banned))).toBe(false)
    }
    expect(Object.keys(roster)).toContain('revokeTerminal')
  })

  it('brings a terminal back only by enrolling it again', () => {
    // Re-recording is what re-enrolment does, and it clears the revocation
    // because it is a new authority rather than the old one resumed.
    recordTerminal(STALL, terminal())
    revokeTerminal(STALL, DOOR)
    expect(isRevoked(STALL, DOOR)).toBe(true)

    recordTerminal(STALL, terminal({ name: 'Door (re-enrolled)' }))
    expect(isRevoked(STALL, DOOR)).toBe(false)
    expect(enrolledCount(STALL)).toBe(1)
  })
})
