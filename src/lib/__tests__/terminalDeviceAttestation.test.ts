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
