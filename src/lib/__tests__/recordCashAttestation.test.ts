/**
 * Deciding whether an attestation from a counterparty may be filed.
 *
 * This value arrives over the network from someone else, so the tests that
 * matter are the ones where that someone is hostile. An earlier version stored
 * it unchecked, and that was a real hole rather than a tidiness problem:
 * anyone who learned a voucher id could post a receipt carrying a garbage
 * signature, it would land on the merchant's row, and — because the first
 * write wins — the genuine attestation from the real customer would then be
 * refused. A merchant could be permanently denied evidence for their own sale
 * by a stranger.
 *
 * The decision is tested here rather than through `recordCashAttestation`,
 * which only adds an IndexedDB read and write around it.
 */
import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

import {
  mayFileAttestation,
  serialiseCashAttestation,
  signCashAttestation,
} from '../cashAttestation'
import { warrantSaleDigest } from '../issuanceWarrant'

const CUSTOMER_SK = hexToBytes('3'.repeat(63) + '7')
const CUSTOMER = bytesToHex(schnorr.getPublicKey(CUSTOMER_SK))

const ATTACKER_SK = hexToBytes('2'.repeat(63) + '8')
const ATTACKER = bytesToHex(schnorr.getPublicKey(ATTACKER_SK))

const STALL_SK = hexToBytes('1'.repeat(63) + '9')
const STALL = bytesToHex(schnorr.getPublicKey(STALL_SK))

const NONCE = 'sale-nonce-xyz'
const SALE = {
  stallPubkey: STALL,
  saleTotalMinor: 2500,
  faceDecimals: 0,
  unit: 'XAF',
  saleNonce: NONCE,
}

/** The warrant the stall signed for this sale, as stored on the row. */
const WARRANT = JSON.stringify({
  form: 'merchant',
  sale_total: 2500,
  face_decimals: 0,
  unit: 'XAF',
  nonce: NONCE,
  sig: bytesToHex(schnorr.sign(warrantSaleDigest(STALL, 2500, 0, 'XAF', NONCE), STALL_SK)),
})

/** A row as `buildIssueTransaction` writes it for a warranted sale. */
function row(over: Record<string, unknown> = {}) {
  return { issuanceWarrant: WARRANT, merchantId: STALL, ...over }
}

const genuine = () => serialiseCashAttestation(signCashAttestation(CUSTOMER_SK, CUSTOMER, SALE))

describe('a hostile attestation is refused', () => {
  it('refuses one signed by somebody other than the customer it names', () => {
    // The attacker signs with their own key while claiming to be the customer.
    const forged = serialiseCashAttestation({
      ...SALE,
      customerPubkey: CUSTOMER,
      paidMinor: 2500,
      signature: bytesToHex(
        schnorr.sign(warrantSaleDigest(STALL, 2500, 0, 'XAF', NONCE), ATTACKER_SK),
      ),
    })

    expect(mayFileAttestation(row(), forged).file).toBe(false)
  })

  it('refuses one naming a stall other than the one that made the sale', () => {
    // THE case that decides where the stall comes from. Reading it off the
    // attestation would compare that field to itself and accept anything.
    const elsewhere = serialiseCashAttestation(
      signCashAttestation(CUSTOMER_SK, CUSTOMER, { ...SALE, stallPubkey: ATTACKER }),
    )

    expect(mayFileAttestation(row(), elsewhere).file).toBe(false)
  })

  it('refuses one for a different sale', () => {
    const otherSale = serialiseCashAttestation(
      signCashAttestation(CUSTOMER_SK, CUSTOMER, { ...SALE, saleNonce: 'some-other-sale' }),
    )

    expect(mayFileAttestation(row(), otherSale).file).toBe(false)
  })

  it('refuses one for a different amount', () => {
    const wrongAmount = serialiseCashAttestation(
      signCashAttestation(CUSTOMER_SK, CUSTOMER, { ...SALE, saleTotalMinor: 100 }),
    )

    expect(mayFileAttestation(row(), wrongAmount).file).toBe(false)
  })

  it('refuses outright garbage rather than storing it', () => {
    expect(mayFileAttestation(row(), '{"customer":"aa","sig":"zz"}').file).toBe(false)
    expect(mayFileAttestation(row(), 'not json at all').file).toBe(false)
  })

  it('refuses an oversized blob even when it is otherwise VALID', () => {
    // It would be written to the merchant's row AND republished to a relay, so
    // an unbounded one is storage and bandwidth a stranger gets to spend.
    //
    // Padded onto a genuine attestation deliberately. A first version of this
    // test used obvious garbage, which was refused for being unparseable - so
    // deleting the size bound left it green and the bound untested. The
    // padding is an unknown key, which JSON.parse accepts and the reader
    // ignores, so the ONLY thing standing between this and storage is the
    // length check.
    const padded = JSON.parse(genuine()) as Record<string, unknown>
    padded.padding = 'a'.repeat(4000)

    const huge = JSON.stringify(padded)
    expect(huge.length).toBeGreaterThan(1024)
    expect(mayFileAttestation(row(), huge).file).toBe(false)
  })

  it('leaves the row open, so the REAL attestation can still arrive', () => {
    // The point of refusing rather than storing-and-flagging. First write
    // wins, so a stored forgery would permanently block the genuine one.
    expect(mayFileAttestation(row(), 'garbage').file).toBe(false)
    expect(mayFileAttestation(row(), genuine()).file).toBe(true)
  })

  it('says why, so a refusal is diagnosable rather than silent', () => {
    expect(mayFileAttestation(row(), 'garbage').reason).toBeDefined()
  })
})

describe('a genuine attestation is filed', () => {
  it('is accepted against the sale it names', () => {
    expect(mayFileAttestation(row(), genuine())).toEqual({ file: true })
  })

  it('does not overwrite one already filed', () => {
    // A redelivery. Replacing a verified attestation with another would reopen
    // the substitution this check exists to close.
    expect(mayFileAttestation(row({ cashAttestation: 'already here' }), genuine()).file)
      .toBe(false)
  })

  it('refuses when the row carries no warrant to check against', () => {
    // Every sale issued before warrants shipped. There is no sale definition
    // to verify against, and storing an uncheckable signature is the hole this
    // was rewritten to close.
    expect(mayFileAttestation(row({ issuanceWarrant: undefined }), genuine()).file).toBe(false)
  })

  it('refuses when the row records no stall', () => {
    // Without one there is nothing to check the attestation's claim against
    // except the claim itself.
    expect(mayFileAttestation(row({ merchantId: undefined }), genuine()).file).toBe(false)
  })
})
