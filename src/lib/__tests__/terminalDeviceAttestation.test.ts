/**
 * What the till itself makes of the owner's attestation at unlock (#160 5b-5, spec 4.6.5), read
 * through `credentialFromToken` on a real signed token. Review rev-5b M2 (L3, L6) and L3.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { credentialFromToken } from '../terminalLogin'
import { buildLockedCredentialToken } from './voucherFixtures'

const STALL_KEY = new Uint8Array(32).fill(2)
const STALL = bytesToHex(schnorr.getPublicKey(STALL_KEY))
const DEVICE = bytesToHex(schnorr.getPublicKey(new Uint8Array(32).fill(3)))
const NONCE = 'c4'.repeat(32)
const UNTIL = 1820071167

function att(stall = STALL, role = 'issue-and-redeem', until = UNTIL) {
  const pre = ['imani-terminal-attestation', '1', stall, DEVICE, role, String(until), NONCE].join('\u001f')
  return { v: '1', expires_at: String(until), nonce: NONCE, sig: bytesToHex(schnorr.sign(sha256(new TextEncoder().encode(pre)), STALL_KEY)) }
}
const base = { terminal: true, stall_pubkey: STALL, role: 'issue-and-redeem', lock_key: DEVICE, name: 'Front' }
const token = (metadata: string, o: { expiresAt?: number; omitExpiry?: boolean } = {}) =>
  buildLockedCredentialToken({ stallKey: STALL_KEY, devicePubkey: DEVICE, role: 'issue-and-redeem', metadata, expiresAt: o.expiresAt ?? UNTIL, ...(o.omitExpiry ? { omitExpiry: true } : {}) })
const read = (meta: object | string, o?: { expiresAt?: number; omitExpiry?: boolean }) =>
  credentialFromToken(token(typeof meta === 'string' ? meta : JSON.stringify(meta), o))

beforeEach(() => {
  vi.stubEnv('VITE_VOUCHER_ISSUER_PUBKEYS', STALL)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the device reading of the attestation', () => {
  it('a genuine attestation unlocks Sell', () => {
    expect(read({ ...base, owner_attestation: att() })?.attested).toBe(true)
  })

  // Ambiguity 2 (spec 4.6.5): malformed reads as missing, as the Java's OWNER_ATTESTATION_MISSING.
  // The till opens, Redeem only. Only a well-formed attestation that fails refuses.
  it.each([
    ['sig uppercased', { ...att(), sig: att().sig.toUpperCase() }],
    ['stripped to {}', {}],
    ['a fifth key', { ...att(), extra: '1' }],
    ['null', null],
  ])('a malformed attestation (%s) opens the till for Redeem only', (_name, a) => {
    const facts = read({ ...base, owner_attestation: a })
    expect(facts).not.toBeNull()
    expect(facts?.attested).toBe(false)
  })

  it('a well-formed attestation by another key refuses the credential', () => {
    const forged = { ...att(), sig: bytesToHex(schnorr.sign(sha256(new Uint8Array([1])), new Uint8Array(32).fill(9))) }
    expect(read({ ...base, owner_attestation: forged })).toBeNull()
  })

  it('a credential that outlives its attestation is refused', () => {
    expect(read({ ...base, owner_attestation: att(STALL, 'issue-and-redeem', UNTIL - 1) })).toBeNull()
  })

  // Review M2 (L6): an attestation bounds the credential's expiry. On a credential with none it
  // bounds nothing, so it is refused, not read as missing.
  it('an attestation on a credential with no expiry is refused', () => {
    expect(read({ ...base, owner_attestation: att() }, { omitExpiry: true })).toBeNull()
  })
})

// Review L3: the device must not read ATTESTED where every verifier refuses the credential.
describe('the device parses the metadata as strictly as the verifiers', () => {
  it('a duplicate owner_attestation key is never attested', () => {
    const meta = JSON.stringify(base).replace(/\}$/, `,"owner_attestation":null,"owner_attestation":${JSON.stringify(att())}}`)
    expect(read(meta)?.attested).not.toBe(true)
  })

  it('a duplicate key elsewhere in the metadata is never attested', () => {
    const meta = JSON.stringify({ ...base, owner_attestation: att() }).replace(/\}$/, ',"name":"Back"}')
    expect(read(meta)?.attested).not.toBe(true)
  })

  it('an uppercase stall_pubkey, even signed in uppercase, is never attested', () => {
    const upper = STALL.toUpperCase()
    expect(read({ ...base, stall_pubkey: upper, owner_attestation: att(upper) })?.attested).not.toBe(true)
  })
})

// #160 phase 6 (F5, Q4): past its expiry a till opens for Redeem only and says so, rather than
// offering a Sell the portal will refuse. Within seven days it warns.
describe('a till past or near its expiry (#160 phase 6, Q4)', () => {
  const login = async (expiresAt: number, nowMs: number) => {
    const { loginFromToken } = await import('../terminalLogin')
    return loginFromToken({ token: token(JSON.stringify({ ...base, owner_attestation: att(STALL, "issue-and-redeem", expiresAt) }), { expiresAt }), devicePubkey: DEVICE, unspent: true, openedAt: nowMs })
  }

  it('opens for Redeem only once expired, with the renewal notice', async () => {
    const { canIssueNow, canRedeemNow } = await import('../terminalSession')
    const { expiryNotice } = await import('../terminalLogin')
    const out = await login(UNTIL, (UNTIL + 1) * 1000)
    if (!out.admitted) throw new Error('expected admission')
    expect(out.actor.expired).toBe(true)
    expect(canRedeemNow(out.actor, out.session)).toBe(true)
    expect(canIssueNow(out.actor, out.session)).toBe(false)
    expect(expiryNotice(out.actor, (UNTIL + 1) * 1000)).toMatch(/authority ran out on .* Ask the owner to renew it\. Redeeming still works\./)
  })

  it('still sells at exactly its expiry second (expired only when now > expires_at)', async () => {
    const { canIssueNow } = await import('../terminalSession')
    const out = await login(UNTIL, UNTIL * 1000)
    if (!out.admitted) throw new Error('expected admission')
    expect(canIssueNow(out.actor, out.session)).toBe(true)
  })

  it('warns within seven days, and says nothing before', async () => {
    const { expiryNotice } = await import('../terminalLogin')
    const soon = await login(UNTIL, (UNTIL - 5 * 86_400) * 1000)
    if (!soon.admitted) throw new Error('expected admission')
    expect(expiryNotice(soon.actor, (UNTIL - 5 * 86_400) * 1000)).toMatch(/stops selling on/)
    const later = await login(UNTIL, (UNTIL - 20 * 86_400) * 1000)
    if (!later.admitted) throw new Error('expected admission')
    expect(expiryNotice(later.actor, (UNTIL - 20 * 86_400) * 1000)).toBeNull()
  })
})
