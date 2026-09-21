import { describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { verifyVoucher, voucherCanonicalBytes, type SignedVoucherFields } from '../voucherToken'
import { credentialActor } from '../terminalCredential'

/**
 * What a coupon proves about WHO ISSUED IT, and what it does not.
 *
 * `issuerId` names a stall. `issuerPublicKey` is the signing SERVICE's key, not
 * that stall's — established in `issuerAllowlist.test.ts`. So the voucher is an
 * attestation: *"the issuing service says stall X issued this"*.
 *
 * This file pins the consequence, which is a real limit rather than a bug:
 * **the attested claim is only as good as the service that signs it.** There is
 * exactly one signature on a voucher, and it belongs to the service. The stall
 * named in `issuerId` never signs anything, so nothing inside a coupon can
 * distinguish a genuine issuance from one a compromised service invented.
 *
 * Recorded because the natural reading of `issuerId` — "this stall signed for
 * this" — is wrong, and reasoning from it would put weight on a beam that is
 * not there. See Finding 6 of
 * `docs/research/audit-double-spend-inflation-review.md` for what would close
 * it (a stall countersignature) and why that is a protocol change rather than a
 * wallet one.
 */

const serviceSk = sha256(new TextEncoder().encode('a signing service'))
const servicePub = bytesToHex(schnorr.getPublicKey(serviceSk))

/** A stall that exists, trades, and never authorised what follows. */
const VICTIM_STALL = 'de'.repeat(32)

function signedBy(sk: Uint8Array, fields: Partial<SignedVoucherFields> = {}): SignedVoucherFields {
  const pub = bytesToHex(schnorr.getPublicKey(sk))
  const unsigned = {
    voucherId: 'v-1',
    issuerId: VICTIM_STALL,
    unit: 'EUR',
    faceValue: 5_000_000,
    faceDecimals: 2,
    issuanceRatio: 1,
    nonce: 'n0',
    merchantMetadata: null,
    issuerSignature: '',
    issuerPublicKey: pub,
    ...fields,
  } as SignedVoucherFields

  return {
    ...unsigned,
    issuerSignature: bytesToHex(schnorr.sign(sha256(voucherCanonicalBytes(unsigned, false)), sk)),
  }
}

describe('what a voucher signature establishes', () => {
  it('proves the bytes were not altered after signing', () => {
    // The real guarantee, and it is not nothing: every field is the signer's
    // own claim rather than a sender-written one, which is why `dmCrypto`
    // prefers the voucher over the DM envelope.
    const genuine = signedBy(serviceSk)
    expect(verifyVoucher(genuine).signatureValid).toBe(true)
    expect(verifyVoucher({ ...genuine, faceValue: 9_999_999 }).signatureValid).toBe(false)
  })

  it('LIMIT: does NOT prove the stall named in issuerId authorised anything', () => {
    // The compromised-service case, stated as an executable fact.
    //
    // Whoever holds the service key can mint any face value in any stall's
    // name, and the result is indistinguishable from a genuine coupon by
    // inspection: the signature verifies, the issuer is a real stall, and the
    // stall in question never signed and never could.
    //
    // The victim learns of it when the coupon is presented back to them for
    // redemption — at which point `refuseIfAnotherStalls` does NOT help either,
    // because `issuerId` says it is theirs.
    const forged = signedBy(serviceSk, { issuerId: VICTIM_STALL })

    expect(verifyVoucher(forged).signatureValid).toBe(true)
    expect(forged.issuerId).toBe(VICTIM_STALL)
    // The only key that signed is the service's. The victim's key appears
    // nowhere in the bytes that were signed.
    expect(forged.issuerPublicKey).toBe(servicePub)
    expect(forged.issuerPublicKey).not.toBe(VICTIM_STALL)
  })

  it('carries exactly ONE signature, which is why there is nothing else to check', () => {
    // If a stall countersignature existed, this is where it would be. The
    // absence is the finding: `SignedVoucherFields` has one signature field.
    //
    // If this test ever fails because a second signature was added, that is
    // the protocol change Finding 6 asks for, and the limit above should be
    // re-examined rather than this test relaxed.
    const genuine = signedBy(serviceSk)
    const signatureFields = Object.keys(genuine).filter((k) => /sig|signature/i.test(k))

    expect(signatureFields).toEqual(['issuerSignature'])
  })

  it('LIMIT: the same key forges AUTHORITY, not only value', () => {
    // The half of the blast radius that is easy to miss. `merchant_metadata`
    // rides inside the canonical bytes, so the one service signature also
    // covers a terminal credential's `stall_pubkey`, `role` and `lock_key`.
    //
    // `credentialActor` defends itself by comparing the voucher's `issuerId`
    // against the metadata's `stall_pubkey` — and a forger supplies both, so
    // they agree. The result is a credential granting issue-and-redeem
    // authority over a stall that authorised nothing, locked to a device key
    // the attacker generated.
    //
    // So a service compromise is an AUTHORISATION incident as well as a
    // minting one, which is why §4 of the handoff lists it separately.
    const attackerDevice = 'ab'.repeat(32)
    const metadata = {
      terminal: true as const,
      stall_pubkey: VICTIM_STALL,
      name: 'Forged',
      role: 'issue-and-redeem' as const,
      lock_key: attackerDevice,
    }
    const credential = signedBy(serviceSk, {
      issuerId: VICTIM_STALL,
      merchantMetadata: JSON.stringify(metadata),
    })

    expect(verifyVoucher(credential).signatureValid).toBe(true)

    const actor = credentialActor(metadata, attackerDevice, { issuerId: credential.issuerId })

    expect(actor).not.toBeNull()
    expect(actor!.stallPubkey).toBe(VICTIM_STALL)
    expect(actor!.permissions).toContain(`voucher:issue:${VICTIM_STALL}`)
  })
})
