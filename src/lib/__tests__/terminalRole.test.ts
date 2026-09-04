import { describe, it, expect } from 'vitest'

import {
  ALL_TERMINAL_ROLES,
  TERMINAL_ACTIONS,
  TERMINAL_ROLES,
  TERMINAL_ROLE_LABELS,
  grantFor,
  isValidGrant,
  mayAct,
  permissionFor,
  roleOf,
} from '../terminalRole'

/**
 * The stall boundary.
 *
 * The spec calls the stall parameter "the riskiest single line in the feature",
 * so these are written adversarially: most of them assert that something does
 * NOT happen. A confirmatory suite here would pass against an implementation
 * that authorised every terminal against every stall on the deployment, because
 * the happy path is identical in both.
 */

const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)

describe('the role catalog', () => {
  it('is closed: an unknown role is refused, not passed through', () => {
    // A role arrives from a voucher tag — through a mint and a QR code — so it
    // is data from outside. Anything unrecognised must be a denial.
    expect(roleOf('redeem-only')).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(roleOf('issue-and-redeem')).toBe(TERMINAL_ROLES.ISSUE_AND_REDEEM)

    for (const bad of ['owner', 'admin', 'ISSUE-AND-REDEEM', '', 'redeem', null, undefined, 7, {}]) {
      expect(roleOf(bad)).toBeNull()
    }
  })

  it('never silently downgrades an unknown role to the weaker one', () => {
    // Defaulting to redeem-only would be a silent downgrade a terminal could
    // not distinguish from working correctly.
    expect(roleOf('something-new')).not.toBe(TERMINAL_ROLES.REDEEM_ONLY)
  })

  it('has words for every role, so a new one cannot ship unnamed', () => {
    for (const role of ALL_TERMINAL_ROLES) {
      expect(TERMINAL_ROLE_LABELS[role]?.name).toBeTruthy()
      expect(TERMINAL_ROLE_LABELS[role]?.hint).toBeTruthy()
    }
  })
})

describe('a permission always names its stall', () => {
  it('cannot be constructed without one', () => {
    // `voucher:redeem:undefined` is a permission that matches nothing — or
    // worse, matches another malformed one. Refusing keeps it at the call site.
    for (const bad of ['', '   ', 'not-a-key', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64)]) {
      expect(() => permissionFor(TERMINAL_ACTIONS.REDEEM, bad)).toThrow(/name the stall/)
    }
  })

  it('carries the stall in the string the gateway will compare', () => {
    expect(permissionFor(TERMINAL_ACTIONS.REDEEM, STALL)).toBe(`voucher:redeem:${STALL}`)
    expect(permissionFor(TERMINAL_ACTIONS.ISSUE, STALL)).toBe(`voucher:issue:${STALL}`)
  })

  it('normalises case, so one stall is not two authorities', () => {
    expect(permissionFor(TERMINAL_ACTIONS.REDEEM, STALL.toUpperCase())).toBe(
      `voucher:redeem:${STALL}`,
    )
  })
})

describe('what each role grants', () => {
  it('gives a redemption-only terminal exactly redemption', () => {
    const grant = grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL)
    expect(grant).toEqual([`voucher:redeem:${STALL}`])
    // The negative that matters: no issuance, at all.
    expect(grant.some((p) => p.startsWith('voucher:issue'))).toBe(false)
  })

  it('gives a full till both, because issuance is additive', () => {
    const grant = grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL)
    expect(grant).toContain(`voucher:issue:${STALL}`)
    expect(grant).toContain(`voucher:redeem:${STALL}`)
  })

  it('names the stall on every permission it emits', () => {
    for (const role of ALL_TERMINAL_ROLES) {
      for (const permission of grantFor(role, STALL)) {
        expect(permission.endsWith(`:${STALL}`)).toBe(true)
      }
    }
  })
})

describe('the cross-stall boundary', () => {
  /**
   * The hole this ticket exists to close. A terminal enrolled by one stall must
   * not be able to act for another, and the check must be unable to answer
   * "yes, for somebody".
   */
  it('does not authorise the same action for a different stall', () => {
    const permissions = grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL)

    expect(mayAct(permissions, TERMINAL_ACTIONS.REDEEM, STALL)).toBe(true)
    expect(mayAct(permissions, TERMINAL_ACTIONS.ISSUE, STALL)).toBe(true)

    // The same terminal, the same actions, somebody else's stall.
    expect(mayAct(permissions, TERMINAL_ACTIONS.REDEEM, OTHER_STALL)).toBe(false)
    expect(mayAct(permissions, TERMINAL_ACTIONS.ISSUE, OTHER_STALL)).toBe(false)
  })

  it('refuses when no stall can be named', () => {
    const permissions = grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL)
    // A caller that cannot name the stall has not established one, and "for
    // somebody" is not an answer an authorization check may give.
    expect(mayAct(permissions, TERMINAL_ACTIONS.REDEEM, '')).toBe(false)
    expect(mayAct(permissions, TERMINAL_ACTIONS.REDEEM, 'not-a-key')).toBe(false)
  })

  it('refuses a bare permission with no stall attached', () => {
    // What a naive implementation would emit. It must authorise nothing.
    expect(mayAct(['voucher:redeem'], TERMINAL_ACTIONS.REDEEM, STALL)).toBe(false)
    expect(mayAct(['redeem'], TERMINAL_ACTIONS.REDEEM, STALL)).toBe(false)
  })

  it('treats an empty permission list as a denial', () => {
    // Matching `canTrade`: silence is never consent.
    expect(mayAct([], TERMINAL_ACTIONS.REDEEM, STALL)).toBe(false)
  })

  it('is not fooled by a stall pubkey that merely starts the same', () => {
    // Guards against a `startsWith`/prefix implementation.
    const prefixy = `${STALL.slice(0, 63)}c`
    const permissions = grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL)
    expect(mayAct(permissions, TERMINAL_ACTIONS.REDEEM, prefixy)).toBe(false)
  })
})

describe('validating a grant that came from somewhere else', () => {
  it('accepts what the role should have produced', () => {
    for (const role of ALL_TERMINAL_ROLES) {
      expect(isValidGrant(grantFor(role, STALL), role, STALL)).toBe(true)
    }
  })

  it('denies an undeclared role rather than passing it', () => {
    expect(isValidGrant([`voucher:redeem:${STALL}`], 'owner', STALL)).toBe(false)
    expect(isValidGrant([], null, STALL)).toBe(false)
  })

  it('denies a redeem-only session carrying issuance', () => {
    // The escalation case: extra authority must not ride along unnoticed.
    const smuggled = [`voucher:redeem:${STALL}`, `voucher:issue:${STALL}`]
    expect(isValidGrant(smuggled, TERMINAL_ROLES.REDEEM_ONLY, STALL)).toBe(false)
  })

  it('denies a session missing what its role requires', () => {
    expect(isValidGrant([`voucher:redeem:${STALL}`], TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL)).toBe(
      false,
    )
  })

  it('denies a permission for another stall, however well formed', () => {
    // Not a weaker session — someone else's business.
    const forOther = grantFor(TERMINAL_ROLES.REDEEM_ONLY, OTHER_STALL)
    expect(isValidGrant(forOther, TERMINAL_ROLES.REDEEM_ONLY, STALL)).toBe(false)
  })

  it('denies anything the catalog does not declare', () => {
    expect(isValidGrant([`stall:delete:${STALL}`], TERMINAL_ROLES.REDEEM_ONLY, STALL)).toBe(false)
  })

  it('denies when the stall itself is malformed', () => {
    expect(isValidGrant([`voucher:redeem:${STALL}`], TERMINAL_ROLES.REDEEM_ONLY, 'nope')).toBe(
      false,
    )
  })
})

describe('the vocabulary', () => {
  it('speaks of terminals and stalls, not subaccounts or employees', () => {
    // CONTEXT.md names the words to avoid. A permission string is the most
    // durable place a wrong one could lodge.
    const surface = [
      ...ALL_TERMINAL_ROLES,
      ...Object.values(TERMINAL_ACTIONS),
      ...ALL_TERMINAL_ROLES.flatMap((r) => [
        TERMINAL_ROLE_LABELS[r].name,
        TERMINAL_ROLE_LABELS[r].hint,
      ]),
    ].join(' ')

    for (const banned of ['subaccount', 'employee', 'delegate', 'merchant', 'vendor', 'shop']) {
      expect(surface.toLowerCase()).not.toContain(banned)
    }
  })
})
