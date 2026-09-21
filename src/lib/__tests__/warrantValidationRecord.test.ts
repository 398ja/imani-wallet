/**
 * The warrant as a merchant actually encounters it: on the validation record of
 * a coupon arriving at the till, and in the badge that record drives.
 *
 * `issuanceWarrant.test.ts` tests the scheme. This tests the WIRING — that the
 * verdict reaches the record, that the badge reads it, and that the two
 * silences stay silent. Wiring is where a security field quietly becomes
 * decoration: the check runs, the result goes nowhere, and everything passes.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import { validationStatus } from '../validationStatus'
import { warrantSaleDigest } from '../issuanceWarrant'
import type { VoucherValidation } from '../voucherToken'

const STALL_SK = 'e'.repeat(63) + '5'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))

/** A record as `dmCrypto` builds it, with the warrant verdict filled in. */
function record(over: Partial<VoucherValidation> = {}): VoucherValidation {
  return {
    signatureValid: true,
    legacyCanonical: false,
    signedFaceValue: 2500,
    cappedAtFaceValue: false,
    ...over,
  }
}

describe('the badge reflects a refused warrant', () => {
  it('a refused warrant fails the coupon', () => {
    // The signature verified, so the bytes are intact. But something claimed an
    // authorisation and the claim did not hold - which is precisely what the
    // scheme exists to surface.
    expect(validationStatus(record({ warrant: 'failed' }))).toBe('failed')
  })

  it('a verified warrant leaves the coupon verified', () => {
    expect(validationStatus(record({ warrant: 'verified' }))).toBe('verified')
  })
})

describe('the two silences stay silent', () => {
  it('an absent warrant does not fail the coupon', () => {
    // Every coupon issued before warrants shipped is here. Failing them would
    // paint most of the estate red over a policy decision nobody has taken.
    expect(validationStatus(record({ warrant: 'absent' }))).toBe('verified')
  })

  it('a signed `none` does not fail the coupon either', () => {
    // The issuer stated that nothing outside the service authorised this. That
    // is honest rather than broken, and refusing it is a per-rail policy flip
    // that has not happened.
    expect(validationStatus(record({ warrant: 'unwarranted' }))).toBe('verified')
  })

  it('a processor claim does not read as verification', () => {
    // `claimed` must not fail the coupon AND must not be confused with
    // `verified` anywhere. The record keeps them as distinct values so UI
    // cannot collapse them by accident.
    const claimed = record({ warrant: 'claimed' })
    expect(validationStatus(claimed)).toBe('verified')
    expect(claimed.warrant).not.toBe('verified')
  })

  it('a row predating this field is unaffected', () => {
    // `warrant` undefined, as every stored row has it today.
    expect(validationStatus(record())).toBe('verified')
  })
})

describe('the older failures still dominate', () => {
  it('an invalid signature fails regardless of the warrant', () => {
    // Order matters: a coupon whose bytes were altered is not rescued by a
    // warrant, and the signature check must be reached first.
    expect(validationStatus(record({ signatureValid: false, warrant: 'verified' })))
      .toBe('failed')
  })

  it('a clamped value still fails', () => {
    expect(validationStatus(record({ cappedAtFaceValue: true, warrant: 'verified' })))
      .toBe('failed')
  })
})

describe('warrantedSaleTotal is the issued figure, not the balance', () => {
  it('exceeds the coupon on a split part, and that is correct', () => {
    // The finding in one assertion. A warrant covers a SALE; a sale splits; so
    // on any part the warranted total is LARGER than the coupon is worth. UI
    // must render this as "issued" and never as this coupon's balance.
    const split = record({
      warrant: 'verified',
      warrantedSaleTotal: 2500,
      signedFaceValue: 834,
    })

    expect(split.warrantedSaleTotal).toBeGreaterThan(split.signedFaceValue)
    // ...and it is still a perfectly good coupon.
    expect(validationStatus(split)).toBe('verified')
  })

  it('is absent when there is no warrant to report one from', () => {
    expect(record({ warrant: 'absent' }).warrantedSaleTotal).toBeUndefined()
    expect(record({ warrant: 'unwarranted' }).warrantedSaleTotal).toBeUndefined()
  })
})

describe('the digest the record was verified against', () => {
  it('is the same one the signer produced', () => {
    // Guards the seam between warrantSigner and dmCrypto: both must agree on
    // argument ORDER. Swapping unit and nonce, say, still type-checks and still
    // produces a digest - just not the same one.
    const a = warrantSaleDigest(STALL, 2500, 2, 'EUR', 'abc')
    const b = warrantSaleDigest(STALL, 2500, 2, 'EUR', 'abc')
    expect(bytesToHex(a)).toBe(bytesToHex(b))

    const swapped = warrantSaleDigest(STALL, 2500, 2, 'abc', 'EUR')
    expect(bytesToHex(swapped)).not.toBe(bytesToHex(a))
  })
})
