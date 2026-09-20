import { describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'
import { hexToBytes } from '@noble/hashes/utils'

import { createDmCryptoAdapter } from '../dmCrypto'
import { buildVoucherToken, dmEnvelope } from './voucherFixtures'

/**
 * Does the receive path refuse a coupon this stall never issued?
 *
 * Drives `createDmCryptoAdapter` — the adapter dm-poll actually installs — with
 * genuinely signed tokens from `voucherFixtures`, rather than calling
 * `verifyVoucher` underneath it. The distinction matters: `verifyVoucher` is one
 * layer below the gate, and a check could exist at the adapter while the
 * primitive stayed permissive. Asking the adapter is asking the question the
 * merchant's till actually asks.
 *
 * These tests DOCUMENT CURRENT BEHAVIOUR, including behaviour that is a finding
 * rather than a guarantee. Where an expectation encodes something undesirable it
 * says so, so that fixing the finding turns the test red on purpose and whoever
 * changes it is told why.
 *
 * See docs/research/audit-double-spend-inflation-review.md, Finding 1.
 */

const signerState = vi.hoisted(() => ({
  privkey: '11'.repeat(32) as string | null,
}))

vi.mock('../nap', () => ({
  getSigner: () => ({
    privkeyHex() {
      if (!signerState.privkey) throw new Error('The wallet is locked.')
      return signerState.privkey
    },
    // Named `borrow` rather than the real signer's `use`: the lint rule reads a
    // bare `use(...)` call as a React hook and fails the file.
    withPrivkey<T>(borrow: (key: Uint8Array) => T): T {
      if (!signerState.privkey) throw new Error('The wallet is locked.')
      return borrow(hexToBytes(signerState.privkey))
    },
  }),
}))

const crypto = createDmCryptoAdapter()

/** A stall that is not us, with a real key so its vouchers really verify. */
const OTHER_STALL = bytesToHex(schnorr.getPublicKey(hexToBytes('22'.repeat(32))))

describe('a coupon issued by another stall, arriving at this till', () => {
  it('is a genuinely signed voucher — the fixture is not the thing under test', () => {
    // Guards the test itself. If the fixture stopped producing a verifiable
    // voucher, every assertion below would pass for the wrong reason: the
    // coupon would be refused as a forgery rather than accepted as another
    // stall's, and the finding would look fixed.
    const { token } = buildVoucherToken({ issuerId: OTHER_STALL })
    const meta = crypto.parseTokenTransferMessage(dmEnvelope(token))

    expect(meta).not.toBeNull()
    expect(
      (meta as unknown as { validation?: { signatureValid?: boolean } }).validation?.signatureValid,
    ).toBe(true)
  })

  it('FINDING: is accepted, though the coupon is a claim on a different stall', () => {
    // `extractToken` is the refusal gate — dmCrypto's own comment calls it
    // "the refusal gate, because parseTokenTransferMessage alone is not one",
    // and returning null here is what makes dm-poll drop the wrap.
    //
    // It returns the token. So the till swaps another stall's coupon at the
    // mint, credits the customer, and attests it publicly.
    //
    // EXPECTED TO FAIL once Finding 1 is fixed. When it does, change it to
    // `toBeNull()` — do not delete it.
    const { token } = buildVoucherToken({ issuerId: OTHER_STALL })

    expect(crypto.extractToken(dmEnvelope(token))).toBe(token)
  })

  it('FINDING: reports the other stall as the issuer, and no refusal with it', () => {
    // The metadata knows perfectly well whose coupon this is — `issuerId` comes
    // off the SIGNED voucher, not the envelope. Every input the check needs is
    // present and in hand; nothing consults it.
    const { token } = buildVoucherToken({ issuerId: OTHER_STALL })
    const meta = crypto.parseTokenTransferMessage(dmEnvelope(token))

    expect(meta!.issuerId).toBe(OTHER_STALL)
  })
})

describe('what the receive path does refuse', () => {
  it('refuses a voucher whose signature does not verify', () => {
    // The check that IS present, verified against the same adapter so the two
    // results are comparable. `tamper` alters the blob after signing, which is
    // the only way to build a genuinely forged voucher.
    const { token } = buildVoucherToken({}, [1000], { faceValue: 999_999 })

    expect(crypto.extractToken(dmEnvelope(token))).toBeNull()
  })

  it('lets plain ecash through, since it carries no issuer claim to check', () => {
    // The case any issuer check must not break. A non-voucher token has nothing
    // to verify and nothing to refuse, and a customer receiving ordinary Cashu
    // is not doing anything wrong.
    const plain = 'cashuBsomethingthatisnotavouchertoken'

    expect(crypto.extractToken(dmEnvelope(plain))).toBe(plain)
  })
})
