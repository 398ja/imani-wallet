import { describe, it, expect } from 'vitest'

import {
  HANDLER,
  attributionFor,
  describeHandler,
} from '../terminalAttribution'
import { TERMINAL_ROLES } from '../terminalRole'
import type { TerminalRecord } from '../terminalRoster'
import type { OwnerActor, TerminalActor } from '../actor'

/**
 * Which terminal handled a movement.
 *
 * Ticket 09. The privacy criterion is attacked in `issueActor.test.ts`, against
 * the payload a customer actually receives. What is here is the reading: an
 * owner must get a name for every row, including for tills they have since
 * retired.
 */

const STALL = 'a'.repeat(64)
const DOOR = 'c'.repeat(64)
const COUNTER = 'd'.repeat(64)

const owner: OwnerActor = { kind: 'owner', stallPubkey: STALL }

const terminal = (key = DOOR): TerminalActor => ({
  kind: 'terminal',
  stallPubkey: STALL,
  role: TERMINAL_ROLES.REDEEM_ONLY,
  terminalPubkey: key,
  permissions: [],
})

const roster = (over: Partial<TerminalRecord> = {}): TerminalRecord[] => [
  {
    terminalPubkey: DOOR,
    name: 'Front counter',
    role: TERMINAL_ROLES.REDEEM_ONLY,
    enrolledAt: 1_000,
    ...over,
  },
]

describe('what gets recorded', () => {
  it('records which terminal handled it', () => {
    expect(attributionFor(terminal())).toEqual({ terminalPubkey: DOOR })
  })

  it('records nothing for the stall’s own device', () => {
    /**
     * Not a field saying "owner". The stall is the default reading and
     * `describeHandler` turns the absence into words — so an owner's history
     * carries no per-row noise about a distinction most stalls never make.
     */
    expect(attributionFor(owner)).toBeUndefined()
    expect(attributionFor(undefined)).toBeUndefined()
    expect(attributionFor(null)).toBeUndefined()
  })

  it('records the terminal’s key rather than its name', () => {
    // Names change. The key is what survives a rename, which is what makes a
    // six-month-old record still resolvable.
    const attribution = attributionFor(terminal())
    expect(attribution).not.toHaveProperty('name')
    expect(attribution!.terminalPubkey).toBe(DOOR)
  })
})

describe('what the owner reads', () => {
  it('names the terminal that handled it', () => {
    const handler = describeHandler({ terminalPubkey: DOOR }, roster())

    expect(handler.kind).toBe(HANDLER.TERMINAL)
    expect(handler.label).toBe('Front counter')
  })

  it('attributes the stall’s own movements to the stall', () => {
    /**
     * The fifth criterion, and the reason it is not left blank: a blank reads
     * as "unknown", and an owner scanning a day's takings should not have to
     * learn that most rows being empty is normal.
     */
    const handler = describeHandler(undefined, roster())

    expect(handler.kind).toBe(HANDLER.STALL)
    expect(handler.label).toBeTruthy()
  })

  it('survives revocation, and says the till is no longer in service', () => {
    /**
     * The fourth criterion. Revoking withdraws authority and never erases
     * history, so a movement from six months ago must still name the till that
     * took it — and must not imply that till is still trading.
     */
    const handler = describeHandler({ terminalPubkey: DOOR }, roster({ revokedAt: 5_000 }))

    expect(handler.kind).toBe(HANDLER.RETIRED)
    // The name AND the status: they answer different questions.
    expect(handler.label).toContain('Front counter')
    expect(handler.label).toMatch(/no longer in service/)
  })

  it('does not silently attribute an unknown terminal to the stall', () => {
    /**
     * A record can outlive its roster row — a re-enrolment under a fresh key,
     * or storage cleared. Saying "your device handled this" would be a claim
     * the data does not support, and would hide a till from a reconciliation.
     */
    const handler = describeHandler({ terminalPubkey: COUNTER }, roster())

    expect(handler.kind).toBe(HANDLER.UNKNOWN)
    expect(handler.kind).not.toBe(HANDLER.STALL)
    expect(handler.label).toBeTruthy()
  })

  it('always has something to show', () => {
    // Every branch, including the empty roster. A blank cell in a
    // reconciliation is worse than any of these answers.
    const cases = [
      describeHandler(undefined, []),
      describeHandler({ terminalPubkey: DOOR }, []),
      describeHandler({ terminalPubkey: DOOR }, roster()),
      describeHandler({ terminalPubkey: DOOR }, roster({ revokedAt: 1 })),
    ]
    for (const handler of cases) {
      expect(handler.label.length).toBeGreaterThan(0)
    }
  })
})
