/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import {
  CREDENTIAL_LIFETIME_DAYS,
  CredentialMintError,
  checkCode,
  credentialDefect,
  credentialRequestBody,
  formatCheckCode,
  mintTerminalCredential,
  type MintTransport,
} from '../terminalMint'
import { buildLockedCredentialToken } from './voucherFixtures'
import { grantFor, TERMINAL_ROLES } from '../terminalRole'
import type { PreparedCredential } from '../terminalIssue'

/**
 * The owner's phone mints a terminal's credential and refuses one that came back wrong
 * (#160 phase 1). Tokens here are built the way gateway-customer mints them, signed for real,
 * so the checks run against genuine bytes. Only the network is faked.
 */

const STALL_KEY = schnorr.utils.randomSecretKey()
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
const DEVICE = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
const OTHER = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))

const prepared: PreparedCredential = {
  name: 'Front counter',
  stallPubkey: STALL,
  role: TERMINAL_ROLES.REDEEM_ONLY,
  lockedTo: DEVICE,
  permissions: grantFor(TERMINAL_ROLES.REDEEM_ONLY, STALL),
}

const good = () => buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE })

function transport(token: string, over: Partial<MintTransport> = {}): MintTransport & {
  post: ReturnType<typeof vi.fn>
} {
  return {
    post: vi.fn(async () => new Response(JSON.stringify({ voucher_id: 'v-1' }), { status: 201 })),
    get: vi.fn(async () => new Response(JSON.stringify({ status: 'ISSUED', token }), { status: 200 })),
    sleep: async () => {},
    ...over,
  } as MintTransport & { post: ReturnType<typeof vi.fn> }
}

describe('the request', () => {
  // The body must be the one the script sends, so the gateway mints the same
  // thing: one sat, the stall as issuer, a year's life, and the signed metadata
  // naming the stall, role and device key.
  it('asks for a one-sat, 365-day credential naming the stall, role and device', () => {
    const body = credentialRequestBody(prepared)

    expect(body).toMatchObject({
      face_value: 1,
      face_unit: 'sat',
      issuer_id: STALL,
      expires_in_days: CREDENTIAL_LIFETIME_DAYS,
      merchant_metadata: {
        terminal: true,
        stall_pubkey: STALL,
        role: TERMINAL_ROLES.REDEEM_ONLY,
        lock_key: DEVICE,
        name: 'Front counter',
      },
    })
    expect(CREDENTIAL_LIFETIME_DAYS).toBe(365)
  })

  // Exactly one call creates the credential: the spec's E2E criterion is "one
  // API call observed on Add".
  it('makes exactly one minting call', async () => {
    const t = transport(good())
    await mintTerminalCredential(prepared, async () => true, t)

    expect(t.post).toHaveBeenCalledTimes(1)
    expect(t.post.mock.calls[0][0]).toBe('/api/v1/wallet/vouchers')
  })
})

describe('the credential is checked from its own bytes', () => {
  // The acceptance criterion: P2PK_VOUCHER, data = K, pubkeys = [S], metadata
  // intact. A token like that passes.
  it('accepts a credential locked to the device with the stall as co-spender', () => {
    expect(credentialDefect(good(), prepared)).toBeNull()
  })

  // The gateway's fallback for a key it cannot lock to is a plain VOUCHER: a
  // bearer authority to the stall. Refused.
  it('refuses an unlocked credential', () => {
    const t = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, kind: 'VOUCHER' })
    expect(credentialDefect(t, prepared)).not.toBeNull()
  })

  // Locked to a device other than the one scanned: useless to this terminal,
  // and someone else's authority.
  it('refuses a credential locked to another device', () => {
    const t = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER })
    expect(credentialDefect(t, prepared)).toBe('wrong-lock')
  })

  // Without the stall in `pubkeys` the owner could never revoke it, which is
  // the case revocation exists for.
  it('refuses a credential the stall cannot spend', () => {
    const t = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, pubkeys: [] })
    expect(credentialDefect(t, prepared)).toBe('no-stall-co-key')
  })

  // A different role than asked for is a different terminal. A redeem-only
  // device must not be handed a till.
  it('refuses a credential whose signed metadata grants another role', () => {
    const t = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: DEVICE,
      role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
    })
    expect(credentialDefect(t, prepared)).toBe('metadata-mismatch')
  })

  // Metadata edited after signing: the issuer signature no longer covers it.
  it('refuses a credential whose signature does not check out', () => {
    const t = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: DEVICE,
      tamperMetadata: JSON.stringify({ terminal: true }),
    })
    expect(credentialDefect(t, prepared)).toBe('bad-signature')
  })

  // Issued by another stall: not this owner's terminal at all.
  it('refuses a credential issued by another stall', () => {
    const t = buildLockedCredentialToken({
      stallKey: schnorr.utils.randomSecretKey(),
      devicePubkey: DEVICE,
      pubkeys: [STALL],
    })
    expect(credentialDefect(t, prepared)).toBe('wrong-issuer')
  })
})

describe('a credential that came back wrong is never left live', () => {
  // A defective credential is spent at once, before the owner is told, so
  // nothing is left out there as a bearer authority to the stall.
  it('spends it and reports that nothing was set up', async () => {
    const bad = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER })
    const spend = vi.fn(async () => true)

    await expect(mintTerminalCredential(prepared, spend, transport(bad))).rejects.toThrow(
      /different device.*cancelled, and nothing was set up/,
    )
    expect(spend).toHaveBeenCalledWith(bad)
  })

  // If the spend itself fails the owner must know something is still out
  // there, rather than read "cancelled".
  it('says so when it could not be cancelled', async () => {
    const bad = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: OTHER })

    const failure = mintTerminalCredential(prepared, async () => false, transport(bad))
    await expect(failure).rejects.toBeInstanceOf(CredentialMintError)
    await expect(failure).rejects.toThrow(/could not be cancelled yet/)
  })

  // The gateway refused outright: the owner reads its reason.
  it('passes on the gateway\'s refusal', async () => {
    const t = transport(good(), {
      post: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Issuer not permitted' } }), { status: 403 }),
      ),
    })
    await expect(mintTerminalCredential(prepared, async () => true, t)).rejects.toThrow(
      /Issuer not permitted/,
    )
  })
})

describe('the check code', () => {
  // Both screens must show the same six digits for the same credential, and a
  // different voucher, stall or device must give a different code.
  it('is six digits, stable, and bound to voucher, stall and device', () => {
    const code = checkCode('v-1', STALL, DEVICE)

    expect(code).toMatch(/^\d{6}$/)
    expect(checkCode('v-1', STALL.toUpperCase(), DEVICE)).toBe(code)
    expect(checkCode('v-2', STALL, DEVICE)).not.toBe(code)
    expect(checkCode('v-1', OTHER, DEVICE)).not.toBe(code)
    expect(checkCode('v-1', STALL, OTHER)).not.toBe(code)
  })

  // Shown as "482 913" so it can be read aloud across a counter.
  it('is shown in two groups of three', () => {
    expect(formatCheckCode('482913')).toBe('482 913')
  })
})
