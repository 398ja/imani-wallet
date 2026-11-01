/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'

import {
  ATTESTATION_EXPIRY_SLACK_SECONDS,
  CREDENTIAL_LIFETIME_DAYS,
  attestEnrolment,
  requestedMetadata,
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

  // #160 review (LOW). The owner's idle lock is signed into the credential's metadata, so the
  // device can read it from the token rather than from its own editable record.
  it('signs the owner’s idle lock into the credential', () => {
    const body = credentialRequestBody({ ...prepared, idleLockMinutes: 0 })
    expect(body.merchant_metadata).toMatchObject({ idle_lock_minutes: 0 })
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

  // #160 review (LOW): the co-spenders must be EXACTLY the stall. A third key
  // in `pubkeys` could also spend, and so revoke or steal, the credential.
  // Before the fix `includes(stall)` let it through.
  it('refuses a credential with a spending key besides the stall', () => {
    const t = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: DEVICE,
      pubkeys: [STALL, OTHER],
    })
    expect(credentialDefect(t, prepared)).toBe('no-stall-co-key')
  })

  // The same rule for a duplicated stall entry: one key, once.
  it('refuses the stall listed twice', () => {
    const t = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: DEVICE,
      pubkeys: [STALL, STALL],
    })
    expect(credentialDefect(t, prepared)).toBe('no-stall-co-key')
  })

  // A refund or locktime path is another way to spend it, which the owner
  // never asked for.
  it('refuses a credential with a refund path', () => {
    const t = buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: DEVICE,
      extraTags: [['refund', `02${OTHER}`]],
    })
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

describe('the owner attests the till at enrolment (#160 decision 5)', () => {
  const signer = { pubkey: STALL, withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(STALL_KEY) }
  const selling: PreparedCredential = {
    ...prepared,
    role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
    permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
    idleLockMinutes: 10,
  }
  const NOW_MS = 1_800_000_000_000
  const attested = (): PreparedCredential => ({ ...selling, attestation: attestEnrolment(selling, signer, NOW_MS) })
  /** What gateway-customer 5b-2 mints for the request: the metadata it was sent, expiry T. */
  const minted = (c: PreparedCredential, over: { metadata?: Record<string, unknown>; expiresAt?: number } = {}) =>
    buildLockedCredentialToken({
      stallKey: STALL_KEY,
      devicePubkey: DEVICE,
      role: c.role,
      metadata: JSON.stringify(over.metadata ?? requestedMetadata(c)),
      expiresAt: over.expiresAt ?? Number(c.attestation!.expires_at),
    })

  // The stall key signs, over this till's stall, lock and role, until a year from now (plus the
  // slack that lets an older gateway's own clock land inside T).
  it('signs with the stall key, for a year plus slack', () => {
    const a = attestEnrolment(selling, signer, NOW_MS)
    expect(a.v).toBe('1')
    expect(Number(a.expires_at)).toBe(NOW_MS / 1000 + 365 * 86_400 + ATTESTATION_EXPIRY_SLACK_SECONDS)
    expect(a.nonce).toMatch(/^[0-9a-f]{64}$/)
  })

  // Review rev-5b M2 (O4): the 600 s is what lets an older gateway's own now + 365 d land inside
  // T, so the owner's app and the gateway deploy in either order. Pinned as a literal, not via
  // the constant, so a slack of 0 fails here.
  it('leaves 600 s of slack past the credential year', () => {
    expect(ATTESTATION_EXPIRY_SLACK_SECONDS).toBe(600)
    const T = Number(attestEnrolment(selling, signer, NOW_MS).expires_at)
    expect(T - NOW_MS / 1000).toBe(365 * 86_400 + 600)
  })

  // Any other key would attest a till no verifier accepts, so it is refused before the mint.
  it('refuses to attest with a key that is not the stall', () => {
    const stranger = schnorr.utils.randomSecretKey()
    const other = { pubkey: bytesToHex(schnorr.getPublicKey(stranger)), withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(stranger) }
    expect(() => attestEnrolment(selling, other, NOW_MS)).toThrow(/stall’s own key/)
  })

  // The request carries the attestation inside its metadata and T in the header gateway-customer
  // compares, beside the Idempotency-Key.
  it('sends the attestation in the metadata and T in X-Idempotency-Expires-At', async () => {
    const c = attested()
    const t = transport(minted(c))
    await mintTerminalCredential(c, async () => true, t, { idempotencyKey: 'k' })
    const [, body, headers] = t.post.mock.calls[0] as [string, Record<string, unknown>, Record<string, string>]
    expect((body.merchant_metadata as Record<string, unknown>).owner_attestation).toEqual(c.attestation)
    expect(headers).toEqual({
      'Idempotency-Key': 'k',
      'X-Idempotency-Expires-At': new Date(Number(c.attestation!.expires_at) * 1000).toISOString().replace('.000Z', 'Z'),
    })
  })

  // What 5b-2 mints for an attested request is accepted as it is.
  it('accepts the credential the gateway minted as asked', () => {
    const c = attested()
    expect(credentialDefect(minted(c), c)).toBeNull()
  })
})

describe('the owner checks the WHOLE metadata came back (spec 4.6.3, credentialDefect)', () => {
  const signer = { pubkey: STALL, withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(STALL_KEY) }
  const c: PreparedCredential = {
    ...prepared,
    role: TERMINAL_ROLES.ISSUE_AND_REDEEM,
    permissions: grantFor(TERMINAL_ROLES.ISSUE_AND_REDEEM, STALL),
    idleLockMinutes: 10,
  }
  const asked = { ...c, attestation: attestEnrolment(c, signer, 1_800_000_000_000) }
  const T = Number(asked.attestation.expires_at)
  const mintedWith = (metadata: Record<string, unknown>, expiresAt = T) =>
    buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, metadata: JSON.stringify(metadata), expiresAt })
  const base = () => requestedMetadata(asked)

  // `name` is not in the attestation digest, so this is the only check that catches a service
  // renaming the till.
  it('refuses a renamed till', () => {
    expect(credentialDefect(mintedWith({ ...base(), name: 'Back counter' }), asked)).toBe('metadata-mismatch')
  })

  // A device holder must not be able to have the idle lock switched off by the service.
  it('refuses an idle lock changed or dropped', () => {
    expect(credentialDefect(mintedWith({ ...base(), idle_lock_minutes: 0 }), asked)).toBe('metadata-mismatch')
    const without = base()
    delete without.idle_lock_minutes
    expect(credentialDefect(mintedWith(without), asked)).toBe('metadata-mismatch')
  })

  // A key the owner never asked for is a claim nobody signed for.
  it('refuses an extra metadata key', () => {
    expect(credentialDefect(mintedWith({ ...base(), free: true }), asked)).toBe('metadata-mismatch')
  })

  // The attestation the owner signed must come back, unaltered.
  it('refuses the attestation dropped or swapped', () => {
    const without = base()
    delete without.owner_attestation
    expect(credentialDefect(mintedWith(without), asked)).toBe('metadata-mismatch')
    const other = attestEnrolment(c, signer, 1_800_000_000_000)
    expect(credentialDefect(mintedWith({ ...base(), owner_attestation: other }), asked)).toBe('metadata-mismatch')
  })

  // A repeated key is two readings of one metadata; JSON.parse would silently keep the last.
  it('refuses metadata text with a repeated key', () => {
    const json = JSON.stringify(base()).replace('{', '{"name":"Evil",')
    const token = buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, metadata: json, expiresAt: T })
    expect(credentialDefect(token, asked)).toBe('metadata-mismatch')
  })

  // The gateway set an expiry later than the T the owner signed: every verifier would refuse the
  // till with ATTESTATION_EXCEEDED, so the owner refuses it now.
  it('refuses a credential that outlives the attestation', () => {
    expect(credentialDefect(mintedWith(base(), T + 1), asked)).toBe('attestation-invalid')
    expect(credentialDefect(mintedWith(base(), T), asked)).toBeNull()
  })

  // Key order and spacing do not matter: the gateway re-serialises the object.
  it('accepts the same metadata in another key order', () => {
    const reordered = Object.fromEntries(Object.entries(base()).reverse())
    expect(credentialDefect(mintedWith(reordered), asked)).toBeNull()
  })
})
