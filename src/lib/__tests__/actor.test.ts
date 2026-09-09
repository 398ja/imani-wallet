import { describe, it, expect } from 'vitest'

import {
  issuingStall,
  mayIssue,
  mayRedeem,
  ownerActor,
  terminalActor,
  type TerminalCredential,
} from '../actor'
import { TERMINAL_ROLES, grantFor } from '../terminalRole'

/**
 * Who a device is acting for.
 *
 * The property under test is a NEGATIVE one, and it is the reason the ticket
 * exists: a coupon must never be stamped with a terminal's own key. A terminal
 * key is disposable — regenerated at every re-enrolment — so a coupon carrying
 * one names an issuer that stops existing, and the customer holding it has a
 * claim on nobody.
 */

const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)
const DEVICE = 'c'.repeat(64)
const OTHER_DEVICE = 'd'.repeat(64)

function credential(over: Partial<TerminalCredential> = {}): TerminalCredential {
  return {
    stallPubkey: STALL,
    role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
    lockedTo: DEVICE,
    permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
    ...over,
  }
}

describe('the owner’s own device', () => {
  it('is the stall, because it signed in as one', () => {
    const actor = ownerActor(STALL)
    expect(actor).not.toBeNull()
    expect(issuingStall(actor!)).toBe(STALL)
  })

  it('is unaffected by this ticket and may still issue', () => {
    // The fourth acceptance criterion: a stall issuing on its own device is
    // stamped exactly as it is today.
    expect(mayIssue(ownerActor(STALL)!)).toBe(true)
    expect(mayRedeem(ownerActor(STALL)!)).toBe(true)
  })

  it('cannot be built from something that is not a key', () => {
    for (const bad of ['', 'not-a-key', 'a'.repeat(63)]) {
      expect(ownerActor(bad)).toBeNull()
    }
  })
})

describe('a terminal acting for its stall', () => {
  it('names the STALL, never its own disposable key', () => {
    // The whole ticket, in one assertion.
    const actor = terminalActor(credential(), DEVICE)

    expect(actor).not.toBeNull()
    expect(issuingStall(actor!)).toBe(STALL)
    expect(issuingStall(actor!)).not.toBe(DEVICE)
    expect(actor!.terminalPubkey).toBe(DEVICE)
  })

  it('may issue when its role says so', () => {
    expect(mayIssue(terminalActor(credential(), DEVICE)!)).toBe(true)
  })

  it('is refused issuance when it is redemption-only', () => {
    // Enforced here AND at the API — the spec requires the role be real, not a
    // hidden button.
    const redeemOnly = terminalActor(
      credential({
        role: TERMINAL_ROLES.REDEEM_ONLY,
        permissions: grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL),
      }),
      DEVICE,
    )

    expect(redeemOnly).not.toBeNull()
    expect(mayIssue(redeemOnly!)).toBe(false)
    // Redemption must never need permission it does not have, and must never
    // need the network — it is the floor every role carries.
    expect(mayRedeem(redeemOnly!)).toBe(true)
  })
})

describe('a credential that does not check out', () => {
  it('is refused when it is locked to another device', () => {
    /**
     * The check the spec's "safe to observe" claim rests on. A credential
     * photographed off someone else's screen must authorise nothing: possession
     * of the bytes is not authority, holding the key it is locked to is.
     */
    expect(terminalActor(credential(), OTHER_DEVICE)).toBeNull()
  })

  it('is refused when it carries no lock at all', () => {
    // A credential with no lock is a bearer token, which is the failure mode
    // ADR 0006 rejects.
    expect(terminalActor(credential({ lockedTo: undefined }), DEVICE)).toBeNull()
    expect(terminalActor(credential({ lockedTo: '' }), DEVICE)).toBeNull()
  })

  it('is refused when its role is not in the catalog', () => {
    // Arrives from a voucher tag, through a mint and a QR: outside data.
    for (const bad of ['owner', 'admin', '', null, 7]) {
      expect(terminalActor(credential({ role: bad }), DEVICE)).toBeNull()
    }
  })

  it('is refused when its stall is malformed', () => {
    for (const bad of ['', 'not-a-key', 'a'.repeat(63), null]) {
      expect(terminalActor(credential({ stallPubkey: bad }), DEVICE)).toBeNull()
    }
  })

  it('is refused when its permissions are for a DIFFERENT stall', () => {
    // The cross-stall case, reached through the credential rather than through
    // terminalRole directly: a session for someone else's business.
    const crossed = credential({
      permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, OTHER_STALL),
    })
    expect(terminalActor(crossed, DEVICE)).toBeNull()
  })

  it('is refused when its permissions exceed its role', () => {
    // A redeem-only credential carrying issuance is an escalation, not a
    // generous session.
    const smuggled = credential({
      role: TERMINAL_ROLES.REDEEM_ONLY,
      permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
    })
    expect(terminalActor(smuggled, DEVICE)).toBeNull()
  })

  it('is refused when it carries no permissions at all', () => {
    // Silence is not consent, matching `canTrade` and `mayAct`.
    expect(terminalActor(credential({ permissions: [] }), DEVICE)).toBeNull()
    expect(terminalActor(credential({ permissions: undefined }), DEVICE)).toBeNull()
  })
})

describe('the issuer can only come from one place', () => {
  it('is the credential’s stall even when the device key looks plausible', () => {
    /**
     * The regression this ticket removes. Before it, issuance read the session
     * pubkey — so on a terminal the coupon would carry DEVICE, a key that stops
     * existing at the next re-enrolment.
     */
    const actor = terminalActor(credential(), DEVICE)!
    expect(issuingStall(actor)).toBe(STALL)
  })

  it('gives the same answer for both kinds of device, so issuance need not ask', () => {
    // `issue.ts` asks one question and never learns which kind it is running
    // on. If these diverged, every caller would need a branch — and the branch
    // is where the session pubkey would creep back in.
    expect(issuingStall(ownerActor(STALL)!)).toBe(STALL)
    expect(issuingStall(terminalActor(credential(), DEVICE)!)).toBe(STALL)
  })
})
