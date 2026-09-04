import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseVoucherToken } from '../voucherToken'
import { credentialActor, parseTerminalMetadata } from '../terminalCredential'
import { TERMINAL_ROLES, grantFor, permissionFor, TERMINAL_ACTIONS } from '../terminalRole'

/**
 * A terminal credential a REAL gateway minted.
 *
 * Everything else about ticket 10 is checked against metadata this app wrote
 * for itself, which proves the parser reads what the parser writes and nothing
 * more. This asserts on the artefact a terminal would actually be handed:
 * minted through `POST /api/v1/wallet/vouchers` on the live stack, signed, and
 * committed as a fixture by `scripts/mint-terminal-credential.mjs`.
 *
 * The bug class it exists to catch is not hypothetical. The gateway has twice
 * dropped `merchant_metadata` before it reached the signed secret
 * (imani-gateway-customer b0fdca5, b282e87). Both times every unit test passed
 * and the credential verified perfectly while granting nothing.
 *
 * ## What minting this actually found
 *
 * That `credentialActor` was reading the wrong field. It compared the stall
 * against the voucher's `issuerPublicKey`, which is the GATEWAY's signing key
 * — identical on every voucher the gateway mints — so it would have refused
 * every real credential ever issued. `issuerId` is the stall, and it is inside
 * the signed bytes. No fixture written by this app could have shown that,
 * because a fixture would have carried whatever the app chose to put there.
 */

const TOKEN = readFileSync(
  join(__dirname, 'fixtures', 'live-terminal-credential.token'),
  'utf8',
).trim()

const parsed = parseVoucherToken(TOKEN)
const STALL = 'b1787b2b98a5244a70d934b393e0179e7ebba0c72579b4a0b238eda3911caa02'
const DEVICE = 'cacc220c14764bfa06f154c662aec0bb339f29a10f2f6e1edd2c83cd10dee752'

describe('the metadata survives the round trip to a real mint', () => {
  it('is still there in the signed secret', () => {
    // The exact failure b0fdca5 and b282e87 caused: a voucher that verifies and
    // carries nothing.
    expect(parsed.voucher.merchantMetadata).toBeTruthy()
  })

  it('is recognisable as a terminal credential', () => {
    expect(parseTerminalMetadata(parsed.voucher.merchantMetadata)).not.toBeNull()
  })

  it('carries the role, stall and lock the owner chose', () => {
    const m = parseTerminalMetadata(parsed.voucher.merchantMetadata)!
    expect(m.role).toBe(TERMINAL_ROLES.REDEEM_ONLY)
    expect(m.stall_pubkey).toBe(STALL)
    expect(m.lock_key).toBe(DEVICE)
    expect(m.name).toBe('Front counter')
  })

  it('names the stall as its issuer, in the signed bytes', () => {
    // `issuerId`, not `issuerPublicKey` — the distinction this fixture taught.
    expect(parsed.voucher.issuerId).toBe(STALL)
    expect(parsed.voucher.issuerPublicKey).not.toBe(STALL)
  })
})

describe('logging in with the real thing', () => {
  const metadata = () => parseTerminalMetadata(parsed.voucher.merchantMetadata)!

  it('admits the device it was minted for', () => {
    const actor = credentialActor(metadata(), DEVICE, { issuerId: parsed.voucher.issuerId })
    expect(actor).not.toBeNull()
    expect(actor!.stallPubkey).toBe(STALL)
    expect(actor!.terminalPubkey).toBe(DEVICE)
  })

  it('is inert on any other device', () => {
    // The whole reason the enrolment QR is safe to photograph.
    const actor = credentialActor(metadata(), 'f'.repeat(64), {
      issuerId: parsed.voucher.issuerId,
    })
    expect(actor).toBeNull()
  })

  it('is refused if some other stall minted it', () => {
    expect(credentialActor(metadata(), DEVICE, { issuerId: 'a'.repeat(64) })).toBeNull()
  })

  it('derives redemption only, from a credential that says redeem-only', () => {
    const actor = credentialActor(metadata(), DEVICE, { issuerId: parsed.voucher.issuerId })!
    expect(actor.permissions).toEqual(grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL))
    expect(actor.permissions).not.toContain(permissionFor(TERMINAL_ACTIONS.ISSUE, STALL))
  })
})
