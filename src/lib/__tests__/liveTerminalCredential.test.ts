import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseVoucherToken, verifyVoucher } from '../voucherToken'
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

/**
 * What the minting script SENT, recorded beside the token when it ran.
 *
 * These were once hardcoded hex. Re-minting the fixture — which the spend probe
 * requires, since a swap consumes the proof — then failed three tests purely
 * because the keys had changed, on a credential that was entirely valid.
 *
 * Read from the sidecar, never from `parsed`: comparing the token against
 * itself would still pass if the gateway dropped the lock, which is the exact
 * bug this file exists to catch.
 */
const MINTED = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'live-terminal-credential.json'), 'utf8'),
) as { stall: string; device: string; role: string; name: string }
const STALL = MINTED.stall
const DEVICE = MINTED.device

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
    expect(m.name).toBe(MINTED.name)
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

/**
 * The lock the MINT enforces, on a credential a real gateway issued.
 *
 * These are `P2PK_VOUCHER` now (ADR 0008), and that change is invisible to
 * every test that only reads metadata — which is how it went unnoticed that
 * `parseVoucherToken` threw on all of them. The wallet could not read a
 * credential the gateway had just minted, and no unit test failed, because
 * every test fed itself a `VOUCHER` it had built.
 */
describe('the lock the mint will actually enforce', () => {
  it('is the locked kind, not a plain voucher that merely names a holder', () => {
    // The distinction is the entire point. Under the plain kind the mint never
    // looks for a witness, so a thief holding the proof can spend it.
    expect(parsed.voucher.lockKey).toBeTruthy()
  })

  it('locks to the device key, as a compressed point', () => {
    // `02` + x-only: the mint checks a witness against THIS, so if it were some
    // other key the credential would be unusable by the terminal it names.
    expect(parsed.voucher.lockKey).toBe('02' + MINTED.device)
  })

  it('enforces the same key it advertises in its metadata', () => {
    // A mismatch would be silent and severe: the roster would show a terminal
    // enrolled against one key while the mint enforced another, so revoking the
    // advertised key would leave the real one spendable.
    const m = parseTerminalMetadata(parsed.voucher.merchantMetadata)!
    expect(parsed.voucher.lockKey).toBe('02' + m.lock_key)
  })

  it("carries the issuer's signature over the bytes that arrived", () => {
    // Locked vouchers keep their tags ON THE WIRE, where the plain kind hides
    // them in a CBOR blob. Verifying means hashing the arriving tag order
    // rather than a reconstruction of it, and tag order is hashed.
    expect(verifyVoucher(parsed.voucher).signatureValid).toBe(true)
  })

  it('fails verification if a single signed tag is altered', () => {
    // The control. Without it the assertion above would pass just as happily
    // against a verifier that returned true unconditionally.
    const wire = new TextDecoder().decode(parsed.voucher.canonicalWire!)
    const tampered = wire.replace('"face_value",1', '"face_value",2')
    expect(tampered).not.toBe(wire)
    expect(
      verifyVoucher({
        ...parsed.voucher,
        canonicalWire: new TextEncoder().encode(tampered),
      }).signatureValid,
    ).toBe(false)
  })
})
