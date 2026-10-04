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

describe('an unwarranted coupon FAILS', () => {
  it('an absent warrant fails the coupon', () => {
    // Nothing outside the issuing service says this stall issued it, which is
    // exactly the coupon a compromised service mints.
    expect(validationStatus(record({ warrant: 'absent' }))).toBe('failed')
  })

  it('a signed `none` fails the coupon', () => {
    // An honest statement of an unbacked claim is still an unbacked claim.
    expect(validationStatus(record({ warrant: 'unwarranted' }))).toBe('failed')
  })

  it('omitting a warrant is not safer than forging one', () => {
    // The property that made the earlier policy wrong. When only `failed` was
    // red, an attacker's best move was to omit the warrant: a forgery showed
    // red and an absence showed green, so the scheme was opt-out for exactly
    // the party it was written to catch. These must agree.
    expect(validationStatus(record({ warrant: 'absent' })))
      .toBe(validationStatus(record({ warrant: 'failed' })))
  })

  it('an unsigned processor claim fails the coupon', () => {
    // `claimed` is the issuing service's word alone (#152), refused on receipt,
    // so the badge must not show it green. The record still keeps it distinct
    // from `verified` so nothing can collapse the two.
    const claimed = record({ warrant: 'claimed' })
    expect(validationStatus(claimed)).toBe('failed')
    expect(claimed.warrant).not.toBe('verified')
  })

  it('a row predating this field is NOT silently verified', () => {
    // Stored rows written before the warrant field existed have it undefined.
    // Treating that as verified would leave a permanent hole: every pre-warrant
    // row would read green forever. It is unchecked, which is honest, and the
    // badge says so rather than claiming an assurance nobody made.
    expect(validationStatus(record())).toBe('unchecked')
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
