/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest'

import { handlerFor } from '../../lib/terminalAttribution'
import { recordTerminal, revokeTerminal } from '../../lib/terminalRoster'
import { TERMINAL_ROLES } from '../../lib/terminalRole'

/**
 * What the owner reads on a record, against a REAL roster.
 *
 * `terminalAttribution.test.ts` covers the reading with a roster passed in.
 * This exercises `handlerFor`, which is what the record screen actually calls
 * — it reads the roster from storage, so a wrong key or a wrong stall would
 * silently produce "no longer listed" for every row.
 */

const STALL = 'a'.repeat(64)
const DOOR = 'c'.repeat(64)

beforeEach(() => localStorage.clear())

describe('the record screen’s own lookup', () => {
  it('names a live terminal from the stall’s roster', () => {
    recordTerminal(STALL, {
      terminalPubkey: DOOR,
      name: 'Front counter',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 1_000,
    })

    expect(handlerFor({ terminalPubkey: DOOR }, STALL).label).toBe('Front counter')
  })

  it('still names it after revocation, marked', () => {
    // "Revoking is not the same as erasing." A sale from six months ago must
    // still say which till took it.
    recordTerminal(STALL, {
      terminalPubkey: DOOR,
      name: 'Front counter',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 1_000,
    })
    revokeTerminal(STALL, DOOR)

    const label = handlerFor({ terminalPubkey: DOOR }, STALL).label
    expect(label).toContain('Front counter')
    expect(label).toMatch(/no longer in service/)
  })

  it('reads the stall’s own sales as the stall', () => {
    expect(handlerFor(undefined, STALL).label).toBe('Your device')
  })

  it('does not find another stall’s terminal', () => {
    // The roster is per stall. Looking a key up against the wrong one must not
    // resolve, or one stall's records could name another's devices.
    recordTerminal('b'.repeat(64), {
      terminalPubkey: DOOR,
      name: 'Not mine',
      role: TERMINAL_ROLES.REDEEM_ONLY,
      enrolledAt: 1,
    })

    expect(handlerFor({ terminalPubkey: DOOR }, STALL).label).not.toContain('Not mine')
  })
})
