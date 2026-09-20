import { describe, it, expect } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

import { commitTo, verifyDisclosedTotal } from '../audit'
import { verifyVoucher, voucherCanonicalBytes, type SignedVoucherFields } from '../voucherToken'

/**
 * Pins two LIMITS of the audit scheme, so that a change which closed either
 * one turns a test red on purpose and whoever made the change is told why.
 *
 * These are not bugs in the ordinary sense. Both need an attacker who has
 * replaced the client: the shipped wallet cannot construct a negative
 * commitment, and the mint refuses a self-issued voucher at swap time. They
 * are recorded here because the DOCUMENTATION around them overstates what is
 * guaranteed, and a test is the one form of documentation that cannot drift.
 *
 * See docs/research/audit-double-spend-inflation-review.md, Findings 2 and 3.
 * Each test says what it would mean for it to fail.
 */

describe('Finding 3: the homomorphic sum has no range proof', () => {
  const N = schnorr.Point.Fn.ORDER
  const G = schnorr.Point.BASE
  const H = schnorr.Point.fromHex(commitTo(0, 1n))

  /** What a modified publisher can do and `commitTo` will not: commit to n - x. */
  const rawCommit = (amount: bigint, blind: bigint) =>
    G.multiply(amount).add(H.multiply(blind)).toHex(true)

  const r1 = 111n
  const r2 = 222n
  const r3 = 333n
  const honest = [commitTo(5000, r1), commitTo(5000, r2), commitTo(5000, r3)]

  it('reconciles an honest set at its true total, and refuses an understated one', () => {
    // The control. If this fails, the benchmark and the attack below prove
    // nothing.
    const blindSum = ((r1 + r2 + r3) % N).toString(16)
    expect(verifyDisclosedTotal(honest, 15000, blindSum)).toBe(true)
    expect(verifyDisclosedTotal(honest, 9000, blindSum)).toBe(false)
  })

  it('LIMIT: one commitment to (n - 6000) makes 9000 reconcile', () => {
    // A commitment to n - x is a well-formed 33-byte point and behaves as -x
    // under addition. The reader checks only the SHAPE of a published point.
    //
    // If this test turns red, a range proof or a bounded-amount check has
    // landed and Finding 3 is closed. Update the review document's verdict
    // table and delete this case; do not weaken the assertion.
    const negative = rawCommit((N - 6000n) % N, 444n)
    expect(/^0[23][0-9a-f]{64}$/i.test(negative)).toBe(true)

    const blindSum = ((r1 + r2 + r3 + 444n) % N).toString(16)
    expect(verifyDisclosedTotal([...honest, negative], 9000, blindSum)).toBe(true)
    expect(verifyDisclosedTotal([...honest, negative], 15000, blindSum)).toBe(false)
  })

  it('commitTo itself refuses a negative amount, so the shipped wallet cannot do this', () => {
    // This is why the finding is graded "modified publisher". The producer
    // refuses; only the reader is permissive.
    expect(() => commitTo(-6000, 1n)).toThrow()
  })
})

describe('Finding 2: verifyVoucher checks a signature against a key the voucher names', () => {
  const sign = (
    fields: Omit<SignedVoucherFields, 'issuerSignature' | 'issuerPublicKey'>,
    sk: Uint8Array,
  ): SignedVoucherFields => {
    const pub = bytesToHex(schnorr.getPublicKey(sk))
    const unsigned = { ...fields, issuerSignature: '', issuerPublicKey: pub } as SignedVoucherFields
    const sig = schnorr.sign(sha256(voucherCanonicalBytes(unsigned, false)), sk)
    return { ...unsigned, issuerSignature: bytesToHex(sig) }
  }

  const base = {
    voucherId: 'v-1',
    unit: 'EUR',
    faceValue: 1_000_000,
    faceDecimals: 2,
    issuanceRatio: 1,
    nonce: 'n0',
    merchantMetadata: null,
  }

  const attacker = sha256(new TextEncoder().encode('an attacker with no stall'))
  const REAL_STALL = 'de'.repeat(32)

  it('LIMIT: a voucher naming a real stall, signed by anyone, is signatureValid', () => {
    // `issuerPublicKey` is carried INSIDE the voucher. Whoever signs it also
    // names the key it is checked against, so this proves the voucher is
    // internally consistent and nothing about who issued it.
    //
    // If this test turns red, a pinned issuer key has landed (Recommendation
    // 4) and Finding 2 is closed. Update the review document and delete this
    // case.
    const forged = sign({ ...base, issuerId: REAL_STALL }, attacker)
    expect(verifyVoucher(forged).signatureValid).toBe(true)
    expect(forged.issuerPublicKey).not.toBe(REAL_STALL)
  })

  it('LIMIT: a wholly self-issued voucher at any face value is signatureValid', () => {
    const self = bytesToHex(schnorr.getPublicKey(attacker))
    const voucher = sign({ ...base, issuerId: self }, attacker)
    expect(verifyVoucher(voucher).signatureValid).toBe(true)
  })

  it('still refuses a voucher whose bytes were altered after signing', () => {
    // The control, and the thing `signatureValid` DOES guarantee. The name
    // invites a stronger reading; this is the whole of what it means.
    const genuine = sign({ ...base, issuerId: REAL_STALL }, attacker)
    const tampered = { ...genuine, faceValue: 999_999_999 }
    expect(verifyVoucher(tampered).signatureValid).toBe(false)
  })
})
