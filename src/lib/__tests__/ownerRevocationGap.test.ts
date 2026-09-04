/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loginTerminal, LOGIN_REFUSAL } from '../terminalLogin'
import { parseVoucherToken } from '../voucherToken'
import {
  recordTerminal,
  revokeTerminal,
  isRevoked,
  allTerminals,
  REVOCATION_DELAY_HOURS,
} from '../terminalRoster'
import { TERMINAL_ROLES } from '../terminalRole'

/**
 * What an owner's revoke actually reaches, and what it does not.
 *
 * Written while inventorying the API surface (.scratch/api-coverage): an
 * endpoint for revocation would inherit whatever the button really does, at
 * machine speed, for integrators who reasonably assume revoke means revoked.
 *
 * ## Bounded is designed; unbounded is not
 *
 * ADR 0005 decides revocation is "bounded, not immediate" — a session outlives
 * its credential by up to `REVOCATION_DELAY_HOURS`, so a till re-authenticates
 * once a trading day rather than mid-shift. A revoked terminal continuing to
 * trade for a while is therefore CORRECT.
 *
 * What is not designed is the delay having no end. The bound only exists if
 * something eventually refuses the credential, and refusal comes from the mint
 * saying SPENT. These tests pin which of those two the owner's button does.
 *
 * They document CURRENT behaviour, including behaviour that looks wrong, and
 * say so where it does — so a fix flips a labelled assertion rather than
 * quietly deleting a passing test.
 */

const TOKEN = readFileSync(
  join(__dirname, 'fixtures', 'live-terminal-credential.token'),
  'utf8',
).trim()
const parsed = parseVoucherToken(TOKEN)
const MINTED = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'live-terminal-credential.json'), 'utf8'),
) as { stall: string; device: string }

const login = (unspent: boolean | null) =>
  loginTerminal({
    merchantMetadata: parsed.voucher.merchantMetadata,
    issuerId: parsed.voucher.issuerId,
    devicePubkey: MINTED.device,
    unspent,
  })

describe('the owner revokes a terminal from their own phone', () => {
  beforeEach(() => {
    localStorage.clear()
    recordTerminal(MINTED.stall, {
      terminalPubkey: MINTED.device,
      role: TERMINAL_ROLES.REDEEM_ONLY,
      name: 'Front counter',
      enrolledAt: Date.now(),
    })
  })

  it('marks the roster row, which is what the owner sees', () => {
    expect(revokeTerminal(MINTED.stall, MINTED.device).revoked).toBe(true)
    expect(isRevoked(MINTED.stall, MINTED.device)).toBe(true)
    expect(
      allTerminals(MINTED.stall).find((t) => t.terminalPubkey === MINTED.device)!.revokedAt,
    ).toBeDefined()
  })

  it('GAP: nothing in the revoke path spends the credential, so the mint still says UNSPENT', () => {
    revokeTerminal(MINTED.stall, MINTED.device)

    // `unspent: true` is not a contrived input. The owner's button issues no
    // mint call whatsoever, so this is the honest state of the credential
    // after a revoke — now, and in twelve hours, and next week.
    const session = login(true)

    // The credential is admitted. Bounded revocation (ADR 0005) means a live
    // SESSION may outlive the credential; it does not mean the credential
    // stays good. When owner-side revocation reaches the mint, this flips to
    // a REVOKED refusal.
    // Narrowed rather than cast: `LoginOutcome` is a discriminated union, and
    // asserting on `admitted` first is what makes the actor readable at all.
    expect(session.admitted).toBe(true)
  })

  it('GAP: so the 12-hour bound never arrives — a fresh login just opens a new session', () => {
    revokeTerminal(MINTED.stall, MINTED.device)

    // The bound assumes the credential is dead and only the SESSION lingers.
    // With the credential alive, each expiry is followed by a fresh login that
    // succeeds, so the delay is not 12 hours but indefinite.
    const afterTheDelay = login(true)

    expect(REVOCATION_DELAY_HOURS).toBe(12)
    expect(afterTheDelay.admitted).toBe(true)
  })

  it('login never reads the roster: revoked and never-enrolled are indistinguishable', () => {
    // The mechanism behind the gap. `loginTerminal` decides on the credential
    // and the mint; the roster is not among its inputs, so the owner's mark
    // cannot reach it even in principle.
    revokeTerminal(MINTED.stall, MINTED.device)
    const revoked = login(true)

    localStorage.clear()
    const neverEnrolled = login(true)

    expect(revoked.admitted).toBe(true)
    expect(neverEnrolled.admitted).toBe(true)
    if (revoked.admitted && neverEnrolled.admitted) {
      expect(revoked.actor).toEqual(neverEnrolled.actor)
    }
  })

  it('is refused once the credential is genuinely SPENT, which is the device path', () => {
    // The control, and what makes the gap precise rather than a guess:
    // refusal works, and is driven entirely by mint state. Device-side
    // decommission spends the credential and produces exactly this. The
    // owner's button is simply not that path.
    const refused = login(false)
    expect(refused.admitted).toBe(false)
    if (!refused.admitted) expect(refused.reason).toBe(LOGIN_REFUSAL.REVOKED)
  })
})
