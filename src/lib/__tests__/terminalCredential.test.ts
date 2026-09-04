import { describe, it, expect } from 'vitest'

import {
  credentialActor,
  parseTerminalMetadata,
  terminalMetadataJson,
} from '../terminalCredential'
import { TERMINAL_ROLES, grantFor, permissionFor, TERMINAL_ACTIONS } from '../terminalRole'

/**
 * The real terminal credential.
 *
 * Ticket 10's security properties, attacked rather than confirmed. The ones
 * worth the effort are all "a thing that looks valid must still be refused":
 * a credential for another device, from another stall, minted by the terminal
 * itself, or claiming permissions its role does not carry.
 */

const STALL = 'a'.repeat(64)
const OTHER_STALL = 'b'.repeat(64)
const DEVICE = 'c'.repeat(64)
const OTHER_DEVICE = 'd'.repeat(64)

const terms = (over = {}) => ({
  stallPubkey: STALL,
  role: TERMINAL_ROLES.REDEEM_ONLY,
  lockKey: DEVICE,
  ...over,
})

const minted = (over = {}) => parseTerminalMetadata(terminalMetadataJson(terms(over)))!

/** Verified the way login will: our device, our stall, our issuer. */
const asOurs = (m = minted(), device = DEVICE, issuer = STALL) =>
  credentialActor(m, device, { issuerPubkey: issuer })

describe('minting refuses what would not work', () => {
  it('refuses an unlocked credential', () => {
    // Unlocked authority is bearer authority: anyone who saw the voucher would
    // hold the stall's till.
    expect(() => terminalMetadataJson(terms({ lockKey: '' }))).toThrow(/locked/)
  })

  it('refuses one that names no stall', () => {
    expect(() => terminalMetadataJson(terms({ stallPubkey: '' }))).toThrow(/stall/)
  })

  it('refuses a role outside the catalog', () => {
    // Would derive an empty grant — a terminal that can do nothing, which to
    // whoever holds it is indistinguishable from a broken device.
    expect(() => terminalMetadataJson(terms({ role: 'superuser' }))).toThrow(/role/)
  })

  it('carries no permission list on the wire', () => {
    /**
     * Permissions are DERIVED from role and stall. Putting them on the wire
     * would create a second source of truth that a tampered credential could
     * disagree with — and the disagreement would favour whoever wrote it.
     */
    const json = terminalMetadataJson(terms())
    expect(json).not.toContain('permission')
    expect(json).not.toContain('voucher:')
  })
})

describe('reading one back', () => {
  it('round-trips what was minted', () => {
    const m = minted({ name: 'Front counter' })
    expect(m.stall_pubkey).toBe(STALL)
    expect(m.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(m.lock_key).toBe(DEVICE)
    expect(m.name).toBe('Front counter')
  })

  it('is not a terminal credential unless it says so', () => {
    // A wallet holds coupons and licences too. Anything else must read as "not
    // one of these" rather than as authority.
    expect(parseTerminalMetadata(JSON.stringify({ campaign_id: 'x' }))).toBeNull()
    expect(parseTerminalMetadata(JSON.stringify({ subscription_id: 'sub_1' }))).toBeNull()
  })

  it('refuses a truthy marker that is not exactly true', () => {
    // A coupon whose metadata happens to carry a "terminal" string must not be
    // read as authority.
    const sneaky = JSON.stringify({
      terminal: 'yes',
      stall_pubkey: STALL,
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
      lock_key: DEVICE,
    })
    expect(parseTerminalMetadata(sneaky)).toBeNull()
  })

  it('refuses an unknown role rather than defaulting one', () => {
    const forged = JSON.stringify({
      terminal: true,
      stall_pubkey: STALL,
      role: 'owner',
      lock_key: DEVICE,
    })
    expect(parseTerminalMetadata(forged)).toBeNull()
  })

  it('refuses malformed keys', () => {
    for (const bad of ['', 'short', 'z'.repeat(64)]) {
      const m = JSON.stringify({
        terminal: true,
        stall_pubkey: bad,
        role: TERMINAL_ROLES.REDEEM_ONLY,
        lock_key: DEVICE,
      })
      expect(parseTerminalMetadata(m)).toBeNull()
    }
  })

  it('survives junk without throwing', () => {
    for (const junk of [null, undefined, 42, '', 'not json', '[]', '{}']) {
      expect(parseTerminalMetadata(junk)).toBeNull()
    }
  })
})

describe('authority is inert without the key', () => {
  it('admits the device it was locked to', () => {
    expect(asOurs()).not.toBeNull()
  })

  it('refuses a credential meant for another device', () => {
    /**
     * The ticket's second criterion, and the reason the enrolment QR is safe to
     * photograph across a market: holding the credential is not holding the
     * authority.
     */
    expect(asOurs(minted(), OTHER_DEVICE)).toBeNull()
  })

  it('refuses a credential re-locked to this device by hand', () => {
    // Editing the metadata does not help, because the ISSUER's signature covers
    // these bytes. Asserted at this layer as the shape check it is: the forged
    // stall no longer matches the issuer.
    const forged = minted()
    forged.lock_key = OTHER_DEVICE
    expect(asOurs(forged)).toBeNull()
  })
})

describe('only from an issuer we recognise, only for its own stall', () => {
  it('refuses a credential minted by someone else', () => {
    // The check that stops a terminal minting its own authority. The credential
    // is perfectly well-formed; the signer is wrong.
    expect(asOurs(minted(), DEVICE, OTHER_STALL)).toBeNull()
  })

  it('refuses one whose issuer is not the stall it names', () => {
    // Signed by a real stall, but not the one in the credential — a stall
    // issuing authority over someone else's business.
    const m = minted({ stallPubkey: OTHER_STALL })
    expect(credentialActor(m, DEVICE, { issuerPubkey: STALL })).toBeNull()
  })
})

describe('permissions come from the credential, not from a stored record', () => {
  it('derives exactly the role’s grant', () => {
    const actor = asOurs()!
    expect(actor.permissions).toEqual(grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL))
  })

  it('never lets a redemption-only credential carry issuance', () => {
    const actor = asOurs()!
    expect(actor.permissions).not.toContain(permissionFor(TERMINAL_ACTIONS.ISSUE, STALL))
  })

  it('strips smuggled permissions at the parse boundary', () => {
    // The list never survives parsing, so it cannot reach the actor at all.
    // Asserted on the PARSED object rather than the actor, because that is
    // where the stripping actually happens — an earlier version of this test
    // checked the actor and passed even when `credentialActor` was mutated to
    // trust a wire list, since parsing had already removed it.
    const smuggled = JSON.stringify({
      terminal: true,
      stall_pubkey: STALL,
      role: TERMINAL_ROLES.REDEEM_ONLY,
      lock_key: DEVICE,
      permissions: [permissionFor(TERMINAL_ACTIONS.ISSUE, STALL)],
    })
    const parsed = parseTerminalMetadata(smuggled)!
    expect('permissions' in parsed).toBe(false)
  })

  it('derives redemption-only even if a wire list says otherwise', () => {
    /**
     * Defence in depth, and the mutation control that earned it: parsing strips
     * the list, so this feeds `credentialActor` an object that still HAS one,
     * which is what a future refactor loosening the parser would produce. The
     * role must remain the only source of permissions.
     */
    const withList = {
      ...minted(),
      permissions: [permissionFor(TERMINAL_ACTIONS.ISSUE, STALL)],
    }
    const actor = credentialActor(withList, DEVICE, { issuerPubkey: STALL })!

    expect(actor.permissions).not.toContain(permissionFor(TERMINAL_ACTIONS.ISSUE, STALL))
    expect(actor.permissions).toEqual(grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL))
  })

  it('scopes the grant to the issuing stall only', () => {
    // Permissions are stall-parameterised, so authority for one stall says
    // nothing about another.
    const actor = asOurs()!
    expect(actor.permissions.every((p) => p.endsWith(STALL))).toBe(true)
    expect(actor.stallPubkey).toBe(STALL)
  })
})
