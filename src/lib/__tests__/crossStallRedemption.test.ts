import { describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils'
import { hexToBytes } from '@noble/hashes/utils'

import { createDmCryptoAdapter } from '../dmCrypto'
import { buildVoucherToken, dmEnvelope } from './voucherFixtures'

/**
 * Where the cross-stall boundary sits, and where it does not.
 *
 * Drives `createDmCryptoAdapter` — the adapter dm-poll actually installs — with
 * genuinely signed tokens from `voucherFixtures`, rather than calling
 * `verifyVoucher` underneath it. The distinction matters: `verifyVoucher` is one
 * layer below the gate, and a check could exist at the adapter while the
 * primitive stayed permissive. Asking the adapter is asking the question the
 * merchant's till actually asks.
 *
 * These tests originally recorded Finding 1 of
 * docs/research/audit-double-spend-inflation-review.md as UNFIXED. It is fixed
 * now, and the refusal lives in `refuseIfAnotherStalls` (see its own test file)
 * rather than here — deliberately, so that a coupon is refused before the mint
 * swap but the gift wrap is not dropped, which would break the sender's reclaim.
 *
 * What remains here is the boundary itself: the adapter recognises and hands
 * through, and the till decides. If that ever changes, these turn red.
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

  it('is accepted at the ADAPTER, which is no longer the whole story', () => {
    // `extractToken` still returns the token, and that is now CORRECT rather
    // than a finding: the refusal moved one layer later, to
    // `refuseIfAnotherStalls` in dmPoll, so that it runs before the mint swap
    // but after the coupon has been recognised.
    //
    // Kept because it pins WHERE the boundary is. If a future change moves the
    // refusal back to delivery, this turns red and whoever did it has to think
    // about the sender's reclaim path, which a dropped wrap breaks.
    //
    // See refuseIfAnotherStalls.test.ts for the refusal itself.
    const { token } = buildVoucherToken({ issuerId: OTHER_STALL })

    expect(crypto.extractToken(dmEnvelope(token))).toBe(token)
  })

  it('reports the other stall as the issuer, which is what the refusal reads', () => {
    // `issuerId` comes off the SIGNED voucher, not the envelope, so it is the
    // issuer's own attested claim. This is the input `refuseIfAnotherStalls`
    // compares against the wallet's own stall key.
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
