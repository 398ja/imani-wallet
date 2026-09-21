/**
 * The customer's half of a cash sale: their own signature that they paid.
 *
 * A warrant proves the stall meant to issue. Only this says money arrived, and
 * only on the rail where no third party can say it for them.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import {
  cashAttestationDigest,
  parseCashAttestation,
  serialiseCashAttestation,
  signCashAttestation,
  verifyCashAttestation,
  attestationForReceivedCoupon,
  parseCashAttestation as parseStored,
  type AttestedSale,
} from '../cashAttestation'

const CUSTOMER_SK = hexToBytes('7'.repeat(63) + '1')
const CUSTOMER = bytesToHex(schnorr.getPublicKey(CUSTOMER_SK))

const OTHER_SK = hexToBytes('6'.repeat(63) + '2')
const OTHER_CUSTOMER = bytesToHex(schnorr.getPublicKey(OTHER_SK))

const STALL = 'b1787b2b98a5244a70d934b393e0179e7ebba0c72579b4a0b238eda3911caa02'

const sale: AttestedSale = {
  stallPubkey: STALL,
  saleTotalMinor: 2500,
  faceDecimals: 0,
  unit: 'XAF',
  saleNonce: 'sale-abc',
}

describe('a customer attesting payment', () => {
  it('verifies against the sale they signed for', () => {
    const attestation = signCashAttestation(CUSTOMER_SK, CUSTOMER, sale)

    expect(verifyCashAttestation(attestation, sale)).toEqual({ verdict: 'attested' })
  })

  it('survives being stored and read back', () => {
    const attestation = signCashAttestation(CUSTOMER_SK, CUSTOMER, sale)
    const restored = parseCashAttestation(serialiseCashAttestation(attestation))

    expect(verifyCashAttestation(restored, sale)).toEqual({ verdict: 'attested' })
  })
})

describe('a missing attestation is never a failure', () => {
  it('reports `none`, not `invalid`', () => {
    // The ordinary case. A sale without one is a normal sale, and anything
    // that treats this as a fault has misread the module.
    expect(verifyCashAttestation(undefined, sale)).toEqual({ verdict: 'none' })
  })

  it('unreadable storage reads as absent rather than throwing', () => {
    expect(parseCashAttestation('{not json')).toBeUndefined()
    expect(parseCashAttestation(undefined)).toBeUndefined()
    expect(parseCashAttestation('{"customer":"ab"}')).toBeUndefined()
  })
})

describe('what an attestation cannot be stretched to cover', () => {
  it('does not carry to a different sale', () => {
    // Attestations are bound to the sale nonce, so yesterday's cannot vouch
    // for today's.
    const attestation = signCashAttestation(CUSTOMER_SK, CUSTOMER, sale)

    const result = verifyCashAttestation(attestation, { ...sale, saleNonce: 'sale-xyz' })
    expect(result.verdict).toBe('invalid')
  })

  it('does not carry to a different stall', () => {
    // Without the stall in the digest, a customer's genuine attestation at one
    // shop would attest payment at another.
    const attestation = signCashAttestation(CUSTOMER_SK, CUSTOMER, sale)

    const result = verifyCashAttestation(attestation, { ...sale, stallPubkey: 'aa'.repeat(32) })
    expect(result.verdict).toBe('invalid')
  })

  it('does not carry to a different AMOUNT, even a smaller one', () => {
    // Equality, not a ceiling. A warrant is a ceiling because a sale splits
    // into coupons; an attestation is one assertion about one sale, so
    // accepting a smaller one would let a EUR 25.00 sale be recorded against a
    // EUR 2.00 signature.
    const attestation = signCashAttestation(CUSTOMER_SK, CUSTOMER, sale)

    expect(verifyCashAttestation(attestation, { ...sale, saleTotalMinor: 100 }).verdict)
      .toBe('invalid')
    expect(verifyCashAttestation(attestation, { ...sale, saleTotalMinor: 9999 }).verdict)
      .toBe('invalid')
  })

  it('does not carry to a different currency', () => {
    // 2500 XAF and 2500 EUR wear the same number and are not the same money.
    const attestation = signCashAttestation(CUSTOMER_SK, CUSTOMER, sale)

    const result = verifyCashAttestation(attestation, { ...sale, unit: 'EUR', faceDecimals: 2 })
    expect(result.verdict).toBe('invalid')
  })

  it('cannot be forged by the merchant on the customer\'s behalf', () => {
    // The whole point. A merchant holding a customer's pubkey cannot produce
    // this, because they do not hold the key.
    const forged = signCashAttestation(OTHER_SK, CUSTOMER, sale)

    expect(verifyCashAttestation(forged, sale).verdict).toBe('invalid')
  })

  it('names the customer it was signed by', () => {
    const attestation = signCashAttestation(OTHER_SK, OTHER_CUSTOMER, sale)

    // Valid, but as a DIFFERENT customer - so a merchant cannot file it under
    // whichever name suits them.
    expect(verifyCashAttestation(attestation, sale)).toEqual({ verdict: 'attested' })
    expect(attestation.customerPubkey).toBe(OTHER_CUSTOMER)
  })
})

describe('the digest', () => {
  it('separates fields that would otherwise collide', () => {
    // total=25/decimals=00 and total=2500/decimals=0 concatenate identically.
    expect(bytesToHex(cashAttestationDigest(CUSTOMER, STALL, 25, 0, 'XAF', 'n'))).not.toBe(
      bytesToHex(cashAttestationDigest(CUSTOMER, STALL, 2, 50, 'XAF', 'n')),
    )
  })

  it('refuses a fractional amount rather than hashing it', () => {
    // Same reasoning as the warrant's: TS and Java must stringify identically,
    // and 2500.5 does not survive that round trip.
    expect(() => cashAttestationDigest(CUSTOMER, STALL, 2500.5, 0, 'XAF', 'n')).toThrow()
  })
})


describe('attesting a coupon as it is received', () => {
  // This is the path that actually runs: the customer's wallet signs while
  // composing the receipt it already posts, with no prompt at a counter.
  const warrantJson = JSON.stringify({
    form: 'merchant',
    sale_total: 2500,
    face_decimals: 0,
    unit: 'XAF',
    nonce: 'sale-abc',
    sig: 'ff'.repeat(64),
  })

  const signWith = (digest: Uint8Array) => bytesToHex(schnorr.sign(digest, CUSTOMER_SK))

  it('produces an attestation the merchant can verify', () => {
    const json = attestationForReceivedCoupon(warrantJson, STALL, CUSTOMER, signWith)

    expect(json).toBeDefined()
    expect(verifyCashAttestation(parseStored(json), sale)).toEqual({ verdict: 'attested' })
  })

  it('binds to the SALE, so every part of a split attests the same thing', () => {
    // A split sale gives each coupon the same warrant, so a customer redeeming
    // any part attests the whole sale - which is what a merchant reconciles.
    const json = attestationForReceivedCoupon(warrantJson, STALL, CUSTOMER, signWith)
    const parsed = parseStored(json)

    expect(parsed?.saleNonce).toBe('sale-abc')
    expect(parsed?.paidMinor).toBe(2500)
  })

  it('returns undefined for a coupon with no warrant', () => {
    // Every coupon issued before warrants shipped. A normal state, not an
    // error: the receipt goes out exactly as it does today.
    expect(attestationForReceivedCoupon(undefined, STALL, CUSTOMER, signWith)).toBeUndefined()
  })

  it('returns undefined for a coupon whose issuer signed `none`', () => {
    // A terminal's sale. There is no stall signature to corroborate.
    const none = JSON.stringify({ form: 'none' })
    expect(attestationForReceivedCoupon(none, STALL, CUSTOMER, signWith)).toBeUndefined()
  })

  it('returns undefined rather than throwing when signing fails', () => {
    // The redemption has already happened when this runs. An exception would
    // turn a completed redemption into a reported failure over optional
    // evidence.
    const boom = () => {
      throw new Error('wallet locked')
    }
    expect(attestationForReceivedCoupon(warrantJson, STALL, CUSTOMER, boom)).toBeUndefined()
  })

  it('attests to the stall named on the COUPON, not one supplied elsewhere', () => {
    // The caller passes issuerId from the coupon's own signed tag. Attesting
    // over an envelope field would let a sender name whichever stall suited
    // them.
    const json = attestationForReceivedCoupon(warrantJson, STALL, CUSTOMER, signWith)

    expect(parseStored(json)?.stallPubkey).toBe(STALL)
    // ...and it does not verify as payment to anyone else.
    expect(
      verifyCashAttestation(parseStored(json), { ...sale, stallPubkey: 'aa'.repeat(32) }).verdict,
    ).toBe('invalid')
  })
})
