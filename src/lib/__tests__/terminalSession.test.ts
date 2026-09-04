import { describe, it, expect } from 'vitest'

import {
  LAPSE,
  LAPSE_MESSAGE,
  SESSION_HOURS,
  SESSION_KIND,
  canIssueNow,
  canRedeemNow,
  issuePermissionFor,
  openSession,
  sessionState,
  type TerminalSession,
} from '../terminalSession'
import { TERMINAL_ROLES, grantFor, type TerminalRole } from '../terminalRole'
import type { OwnerActor, TerminalActor } from '../actor'
import { REVOCATION_DELAY_HOURS } from '../terminalRoster'

/**
 * Sessions, lapse, and reduced authority.
 *
 * The properties worth attacking are the ones where a plausible implementation
 * is wrong in a way nobody notices: a lapsed terminal that still redeems, a
 * reduced session that still issues, and an owner accidentally dragged into
 * either.
 */

const STALL = 'a'.repeat(64)
const DEVICE = 'c'.repeat(64)
const HOUR = 3600 * 1000
/**
 * Sessions are opened "now" rather than at a fixed epoch, because several of
 * these read `sessionState` with its DEFAULT clock. A 1970 timestamp would make
 * every such session expired and the tests would pass for the wrong reason.
 */
const NOW = Date.now()

const owner: OwnerActor = { kind: 'owner', stallPubkey: STALL }

function terminal(role: TerminalRole = TERMINAL_ROLES.ISSUE_AND_REDEEM): TerminalActor {
  return {
    kind: 'terminal',
    stallPubkey: STALL,
    role,
    terminalPubkey: DEVICE,
    permissions: grantFor(role, STALL),
  }
}

function session(over: Partial<TerminalSession> = {}): TerminalSession {
  return { ...openSession(terminal(), SESSION_KIND.FULL, NOW), ...over }
}

describe('the session ceiling', () => {
  it('is one trading day, the same number the owner was promised', () => {
    // Imported rather than restated: if these could differ, the owner would be
    // told twelve hours while the terminal traded for longer.
    expect(SESSION_HOURS).toBe(REVOCATION_DELAY_HOURS)
  })

  it('caps the session rather than trusting anything passed in', () => {
    // An explicit epoch here, because this one is about arithmetic rather than
    // about liveness.
    const s = openSession(terminal(), SESSION_KIND.FULL, 1_000_000)
    expect(s.expiresAt).toBe(1_000_000 + SESSION_HOURS * HOUR)
  })
})

describe('what a lapsed terminal says', () => {
  it('stops trading once the day has rolled over', () => {
    const s = session()
    const state = sessionState(s, { now: s.expiresAt })

    expect(state.live).toBe(false)
    if (!state.live) expect(state.reason).toBe(LAPSE.EXPIRED)
  })

  it('is still live a moment before expiry', () => {
    // The boundary in the other direction, so "expired" cannot be implemented
    // as "always".
    const s = session()
    expect(sessionState(s, { now: s.expiresAt - 1 }).live).toBe(true)
  })

  it('never tells a revoked terminal to sign in again', () => {
    /**
     * Both end trading, but "sign in again for today" instructs staff to do the
     * one thing the owner has just prevented — and sends them to the owner with
     * the wrong question. Revocation is checked first for this reason alone.
     */
    const s = session()
    const state = sessionState(s, { revoked: true, now: s.openedAt })

    expect(state.live).toBe(false)
    if (!state.live) {
      expect(state.reason).toBe(LAPSE.REVOKED)
      expect(state.message).not.toMatch(/today/)
    }
  })

  it('prefers revoked over expired when both are true', () => {
    const s = session()
    const state = sessionState(s, { revoked: true, now: s.expiresAt + HOUR })
    if (!state.live) expect(state.reason).toBe(LAPSE.REVOKED)
  })

  it('treats a missing session as lost authority, not as expiry', () => {
    const state = sessionState(null)
    expect(state.live).toBe(false)
    if (!state.live) expect(state.reason).toBe(LAPSE.INVALID)
  })

  it('says what happened and what to do, in every case', () => {
    // "Say so once and stop offering to serve" is useless if the sentence
    // leaves somebody guessing whether to retry.
    for (const reason of Object.values(LAPSE)) {
      expect(LAPSE_MESSAGE[reason]).toMatch(/owner/)
      expect(LAPSE_MESSAGE[reason].length).toBeGreaterThan(20)
    }
  })

  it('does not dress up the most routine event in the system', () => {
    // Every terminal expires every day. An alarming message for that would
    // teach staff to ignore all of them.
    expect(LAPSE_MESSAGE[LAPSE.EXPIRED]).not.toMatch(/error|failed|invalid|denied/i)
  })
})

describe('a lapsed terminal stops offering to serve', () => {
  it('cannot redeem once expired, however senior its role', () => {
    const s = session()
    expect(canRedeemNow(terminal(), s)).toBe(true)
    expect(canRedeemNow(terminal(), { ...s, expiresAt: s.openedAt })).toBe(false)
  })

  it('cannot issue once expired', () => {
    const s = session()
    expect(canIssueNow(terminal(), { ...s, expiresAt: s.openedAt })).toBe(false)
  })

  it('can do nothing at all with no session', () => {
    expect(canIssueNow(terminal(), null)).toBe(false)
    expect(canRedeemNow(terminal(), null)).toBe(false)
  })
})

describe('reduced authority', () => {
  const reduced = () => openSession(terminal(), SESSION_KIND.REDUCED, NOW)

  it('keeps redemption working, because the queue cannot wait', () => {
    expect(canRedeemNow(terminal(), reduced())).toBe(true)
  })

  it('refuses issuance even to a terminal whose role allows it', () => {
    /**
     * The half that matters. Issuing on an authority nobody could check is
     * money created on a guess, and unlike a redemption it cannot be
     * reconciled away afterwards. The role here is the SENIOR one, so this
     * cannot pass by accident.
     */
    expect(canIssueNow(terminal(TERMINAL_ROLES.ISSUE_AND_REDEEM), reduced())).toBe(false)
  })

  it('is a working session, not a lapsed one', () => {
    expect(sessionState(reduced()).live).toBe(true)
  })

  it('still expires on the same ceiling', () => {
    const s = reduced()
    expect(sessionState(s, { now: s.expiresAt }).live).toBe(false)
  })
})

describe('role gating survives the session', () => {
  it('never lets a redemption-only terminal issue, on any session', () => {
    for (const kind of Object.values(SESSION_KIND)) {
      const s = openSession(terminal(TERMINAL_ROLES.REDEEM_ONLY), kind, NOW)
      expect(canIssueNow(terminal(TERMINAL_ROLES.REDEEM_ONLY), s)).toBe(false)
    }
  })

  it('lets a redemption-only terminal redeem, which is its whole job', () => {
    const s = openSession(terminal(TERMINAL_ROLES.REDEEM_ONLY), SESSION_KIND.FULL, NOW)
    expect(canRedeemNow(terminal(TERMINAL_ROLES.REDEEM_ONLY), s)).toBe(true)
  })

  it('names the permission a request would have to carry', () => {
    // So the enforcement point and the screen ask the same question of the same
    // data. Hiding is the courtesy; this is the control.
    const needed = issuePermissionFor(STALL)
    expect(grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL)).not.toContain(needed)
    expect(grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL)).toContain(needed)
  })
})

describe('a stall on its own device sees no change', () => {
  it('issues and redeems with no session at all', () => {
    // The ticket's fifth criterion, and it holds structurally: the owner path
    // never acquires a session, so there is nothing to lapse.
    expect(canIssueNow(owner, null)).toBe(true)
    expect(canRedeemNow(owner, null)).toBe(true)
  })

  it('is unaffected by an expired or reduced session handed to it', () => {
    const dead = { ...session(), expiresAt: 0 }
    expect(canIssueNow(owner, dead)).toBe(true)
    expect(canIssueNow(owner, openSession(terminal(), SESSION_KIND.REDUCED, 1))).toBe(true)
  })
})
