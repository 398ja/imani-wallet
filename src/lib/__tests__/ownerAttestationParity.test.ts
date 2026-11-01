/**
 * The wallet's owner-attestation code agrees with cashu-voucher 0.17.0, on the Java's own vectors.
 *
 * `fixtures/ownerAttestationVectors0170.json` is copied byte for byte from cashu-voucher's
 * `cashu-voucher-domain/src/test/resources/owner-attestation-vectors.json`, which the Java's
 * `OwnerAttestationVectorsTest` replays. Every digest, every signature and every refusal below was
 * produced by the Java, not written to match this code. If a vector fails here, one side changed:
 * do not regenerate the file to make it pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { attestationDigest, attestationPreimage, ATTESTATION_DOMAIN, signOwnerAttestation } from '../ownerAttestation'
import { verifyOwnerAttestation, verifyTerminalWarrant } from '../terminalWarrant'
import { parseIssuanceWarrant, verifyIssuanceWarrant } from '../issuanceWarrant'
import vectors from './fixtures/ownerAttestationVectors0170.json'

interface CredentialVector {
  name: string
  issuer_id: string
  credential_wire: string
  owner_attestation_refusal: string | null
  terminal: {
    sale_total_minor: number
    face_decimals: number
    unit: string
    sale_nonce: string
    signature_hex: string
    coupon_face_minor: number
    trusted_service_keys: string[]
    expiry_check: 'skip-offline' | number
    refusal: string | null
  }
}

const credentials = vectors.credential_vectors as CredentialVector[]

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('the Java vector file', () => {
  // A truncated or swapped file must not pass by having fewer cases to fail.
  it('is the 0.17.0 file, with its domain, separator and every case', () => {
    expect(vectors.domain).toBe(ATTESTATION_DOMAIN)
    expect(vectors.separator).toBe('\u001f')
    expect(vectors.digest_vectors.length).toBe(3)
    expect(credentials.length).toBe(32)
  })
})

describe('the digest, byte for byte', () => {
  // The preimage and the digest are the Java's own output for these fields.
  it.each(vectors.digest_vectors.map((d) => [d.name, d] as const))('%s', (_name, d) => {
    expect(bytesToHex(attestationPreimage(d.v, d.stall_pubkey, d.lock_key, d.role, d.expires_at, d.nonce))).toBe(
      d.preimage_hex,
    )
    expect(bytesToHex(attestationDigest(d.v, d.stall_pubkey, d.lock_key, d.role, d.expires_at, d.nonce))).toBe(
      d.digest_hex,
    )
  })

  // The owner's wallet signs what the Java verifies: our signature over the vector's fields
  // verifies against the stall key, over the Java's digest.
  it('signs at enrolment exactly the digest the Java verifies', () => {
    const d = vectors.digest_vectors[0]
    const signer = {
      pubkey: vectors.keys.stall.pub,
      withPrivkey: <T,>(f: (k: Uint8Array) => T) => f(hexToBytes(vectors.keys.stall.priv)),
    }
    const a = signOwnerAttestation(
      { stallPubkey: d.stall_pubkey, lockKey: d.lock_key, role: d.role, expiresAt: Number(d.expires_at) },
      signer,
      d.nonce,
    )
    expect(schnorr.verify(hexToBytes(a.sig), hexToBytes(d.digest_hex), hexToBytes(d.stall_pubkey))).toBe(true)
  })
})

describe('verifyOwnerAttestation gives the Java answer on every credential', () => {
  // The standalone check the gateways and the till run: null, or the Java's refusal name.
  it.each(credentials.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(verifyOwnerAttestation(c.credential_wire, c.issuer_id)).toBe(c.owner_attestation_refusal)
  })
})

describe('verifyTerminalWarrant gives the Java answer on every credential', () => {
  // The full sale check the portal runs at issuance and a customer's wallet runs on receipt.
  it.each(credentials.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const t = c.terminal
    const verdict = verifyTerminalWarrant({
      issuerId: c.issuer_id,
      credential: c.credential_wire,
      trustedServiceKeys: t.trusted_service_keys,
      saleTotalMinor: t.sale_total_minor,
      faceDecimals: t.face_decimals,
      unit: t.unit,
      saleNonce: t.sale_nonce,
      signatureHex: t.signature_hex,
      couponFaceMinor: t.coupon_face_minor,
      expiryCheck: t.expiry_check === 'skip-offline' ? 'skip-offline' : { at: t.expiry_check },
    })
    expect(verdict.valid ? null : verdict.refusal).toBe(t.refusal)
  })
})

describe('what a customer reads for each Java vector (review M7)', () => {
  /**
   * The customer's verdict, spec 4.6.3: a valid attestation reads `verified`; a MISSING one
   * reads `unwarranted` (unsigned by the stall, not tampered with); a BAD or EXCEEDED one reads
   * `failed`. Skip-offline vectors only: a customer never checks expiry against now.
   */
  const expected = (refusal: string | null): string =>
    refusal === null ? 'verified' : refusal === 'OWNER_ATTESTATION_MISSING' ? 'unwarranted' : 'failed'

  const offline = credentials.filter((c) => c.terminal.expiry_check === 'skip-offline')

  it.each(offline.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const t = c.terminal
    const warrant = parseIssuanceWarrant(
      JSON.stringify({
        form: 'terminal',
        sale_total: t.sale_total_minor,
        face_decimals: t.face_decimals,
        unit: t.unit,
        nonce: t.sale_nonce,
        signature: t.signature_hex,
        credential: c.credential_wire,
      }),
    )
    const verdict = verifyIssuanceWarrant(
      warrant,
      c.issuer_id,
      { faceValueMinor: t.coupon_face_minor, unit: t.unit, faceDecimals: t.face_decimals },
      { trustedServiceKeys: t.trusted_service_keys },
    )
    expect(verdict.verdict).toBe(expected(t.refusal))
  })

  // Each of the three verdicts is reached by at least one Java vector, so none is untested.
  it('covers verified, unwarranted and failed', () => {
    const seen = new Set(offline.map((c) => expected(c.terminal.refusal)))
    expect([...seen].sort()).toEqual(['failed', 'unwarranted', 'verified'])
  })
})
