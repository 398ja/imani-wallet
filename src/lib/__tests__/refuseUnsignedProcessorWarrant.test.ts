/**
 * The till refuses an unsigned `processor` warrant (#152).
 *
 * A `processor` warrant names a payment record but carries no signature, and
 * nothing on this device can check the record. So it is the issuing service's
 * word alone, which is exactly the trust a warrant exists to remove: any
 * merchant session could ask the portal to mint one (imani-gateway-portal#54).
 *
 * Driven from a coupon's real fields through `buildValidationRecord`, the same
 * builder every receive path uses, into `refuseIfUnwarranted`, the gate that
 * runs before the mint swap. A test that fed a hand-written verdict straight in
 * would pass even if the builder stopped producing it.
 */
import { describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

// `isWarranted` takes a token string. The token encoding is not what this file
// tests, so the parser reads a JSON-encoded ParsedVoucherToken instead of
// TokenV4. Everything else in voucherToken stays real.
vi.mock('../voucherToken', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../voucherToken')>()),
  parseVoucherToken: (token: string) => JSON.parse(token),
}))

import { refuseIfUnwarranted } from '../dmPoll'
import { isWarranted } from '../merchants'
import { warrantSaleDigest } from '../issuanceWarrant'
import { buildValidationRecord } from '../voucherValidationRecord'
import type { ParsedVoucherToken, SignedVoucherFields } from '../voucherToken'

const STALL_SK = 'c'.repeat(63) + '7'
const STALL = bytesToHex(schnorr.getPublicKey(hexToBytes(STALL_SK)))
const SALE_TOTAL = 2500
const DECIMALS = 2
const UNIT = 'EUR'
const NONCE = '5e1f0c2b3a4d6e7f8091a2b3c4d5e6f7'

/** A parsed coupon worth the whole sale, carrying `warrant` in its signed tags. */
function coupon(warrant: string): ParsedVoucherToken {
  const voucher = {
    voucherId: '0b9f1f5e-6c3c-4f43-9a63-2f1d6b2f8a10',
    issuerId: STALL,
    unit: UNIT,
    faceValue: SALE_TOTAL,
    faceDecimals: DECIMALS,
    issuanceRatio: 1,
    issuanceWarrant: warrant,
  } as unknown as SignedVoucherFields
  return {
    mintUrl: 'https://mint.example',
    unit: 'sat',
    tokenAmount: SALE_TOTAL,
    proofCount: 1,
    voucher,
  } as ParsedVoucherToken
}

/** The receive-time meta for a coupon whose issuer signature checked out. */
function metaFor(warrant: string) {
  const { record } = buildValidationRecord(coupon(warrant), {
    signatureValid: true,
    legacyCanonical: false,
  } as never)
  return { voucherId: '0b9f1f5e-6c3c-4f43-9a63-2f1d6b2f8a10', validation: record }
}

function processorWarrant(): string {
  return JSON.stringify({
    form: 'processor',
    sale_total: SALE_TOTAL,
    face_decimals: DECIMALS,
    unit: UNIT,
    nonce: NONCE,
    ref: 'pi_3PzForged',
  })
}

function merchantWarrant(): string {
  const digest = warrantSaleDigest(STALL, SALE_TOTAL, DECIMALS, UNIT, NONCE)
  const sig = bytesToHex(schnorr.sign(digest, hexToBytes(STALL_SK)))
  return JSON.stringify({
    form: 'merchant',
    sale_total: SALE_TOTAL,
    face_decimals: DECIMALS,
    unit: UNIT,
    nonce: NONCE,
    sig,
  })
}

describe('an unsigned processor warrant is refused before the swap', () => {
  // Within the ceiling, right currency, real-looking reference: everything a
  // forger controls. None of it is checkable here, so it must not pass.
  it('refuses a coupon whose only warrant is an unsigned processor claim', () => {
    const meta = metaFor(processorWarrant())
    expect(meta.validation.warrant).toBe('claimed')
    expect(() => refuseIfUnwarranted(meta)).toThrow(/no usable authorisation/)
  })

  // The refusal carries the `unwarranted` reason, so the merchant sees the same
  // "Coupon not authorised" toast as for any other unauthorised coupon.
  it('refuses it with the same reason as an unwarranted coupon, so the toast matches', () => {
    try {
      refuseIfUnwarranted(metaFor(processorWarrant()))
      throw new Error('should have refused')
    } catch (e) {
      expect((e as { reason?: string }).reason).toBe('unwarranted')
    }
  })

  // The send-screen flag must agree with the receive gate, or a customer is
  // told a coupon is fine that the stall will then refuse.
  it('does not count a processor-warranted coupon as warranted when sending', () => {
    expect(isWarranted({ token: JSON.stringify(coupon(processorWarrant())) })).toBe(false)
  })
})

describe('a merchant-signed warrant still passes', () => {
  // The ordinary Sell coupon: signed by the stall's own key. It verifies and is
  // accepted, so refusing processor claims costs real sales nothing.
  it('accepts a coupon carrying the stall’s own signature', () => {
    const meta = metaFor(merchantWarrant())
    expect(meta.validation.warrant).toBe('verified')
    expect(() => refuseIfUnwarranted(meta)).not.toThrow()
  })

  // The send-screen flag still counts a merchant-signed coupon as warranted.
  it('counts a merchant-signed coupon as warranted when sending', () => {
    expect(isWarranted({ token: JSON.stringify(coupon(merchantWarrant())) })).toBe(true)
  })
})
