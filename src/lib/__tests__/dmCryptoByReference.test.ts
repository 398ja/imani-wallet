import { describe, it, expect, vi } from 'vitest'

import { buildVoucherToken, dmEnvelope } from './voucherFixtures'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * A stand-in for the app's signer, lockable like the real one.
 *
 * `vi.hoisted` because `vi.mock` is hoisted above the imports, so its factory
 * cannot close over an ordinary `const` declared below it.
 */
const signerState = vi.hoisted(() => ({ privkey: null as string | null, pubkey: '' }))
const collectEnrolled = vi.hoisted(() => vi.fn(async () => 0))

vi.mock('../terminalDeliveryNet', () => ({ collectEnrolled }))

vi.mock('../nap', () => ({
  getSigner: () => ({
    get pubkey() {
      return signerState.pubkey
    },
    privkeyHex() {
      if (!signerState.privkey) throw new Error('The wallet is locked.')
      return signerState.privkey
    },
    // IW-14: the scoped borrow, which throws while locked exactly as privkeyHex did — the
    // locked-wallet case must stay distinguishable from a malformed wrap.
    withPrivkey<T>(borrow: (key: Uint8Array) => T): T {
      if (!signerState.privkey) throw new Error('The wallet is locked.')
      return borrow(hexToBytes(signerState.privkey))
    },
  }),
}))
import { createDmCryptoAdapter as adapter } from '../dmCrypto'
import { parseVoucherToken, tokenProofs } from '../voucherToken'
import { buildPlainToken } from './voucherFixtures'
import { referenceSecret, toByReference, tokenWithRawV } from './byReference'

/**
 * cashu-voucher#64, review fix: a by-reference voucher that cannot be verified (document missing,
 * or an invalid `v` map) is REJECTED by the DM layer, never handed on as plain ecash. Every other
 * parse failure, and v1, behave exactly as before.
 */
describe('dmCrypto and by-reference vouchers', () => {
  const crypto = adapter()

  it('a v1 voucher flows as before, and its v2 form reads the same', () => {
    const { token } = buildVoucherToken()
    expect(crypto.extractToken(dmEnvelope(token))).toBe(token)
    const v2 = toByReference(token)
    expect(crypto.extractToken(dmEnvelope(v2))).toBe(v2)
    const a = crypto.parseTokenTransferMessage(dmEnvelope(token))
    const b = crypto.parseTokenTransferMessage(dmEnvelope(v2))
    expect((b as Record<string, unknown> | null)?.validation).toEqual((a as Record<string, unknown> | null)?.validation)
    expect(b?.faceValue).toBe(a?.faceValue)
  })

  it('a v2 token without its document is REJECTED', () => {
    const t = tokenWithRawV(buildVoucherToken().token, [])
    expect(crypto.extractToken(dmEnvelope(t))).toBeNull()
    expect(crypto.parseTokenTransferMessage(dmEnvelope(t))).toBeNull()
  })

  it('a v2 token with a tampered v map is REJECTED', () => {
    const v1 = buildVoucherToken().token
    const m = new Map<string, Uint8Array>()
    referenceSecret(tokenProofs(v1)[0].secret, m)
    const [[k, d]] = [...m.entries()]
    const bad = d.slice()
    bad[5] ^= 1
    const t = tokenWithRawV(v1, [[k, bad]])
    expect(() => parseVoucherToken(t)).toThrow()
    expect(crypto.extractToken(dmEnvelope(t))).toBeNull()
    expect(crypto.parseTokenTransferMessage(dmEnvelope(t))).toBeNull()
  })

  it('plain ecash and undecodable tokens still flow', () => {
    const plain = buildPlainToken('http://mint.test')
    expect(crypto.extractToken(dmEnvelope(plain))).toBe(plain)
    expect(crypto.extractToken(dmEnvelope('cashuBnotavoucher'))).toBe('cashuBnotavoucher')
  })
})

describe('cashbackValidation and by-reference vouchers', () => {
  it('an invalid v map reads as an unreadable coupon, not as plain ecash', async () => {
    const { cashbackValidation } = await import('../cashbackValidation')
    const v1 = buildVoucherToken().token
    const empty = new Uint8Array(0)
    const bad = tokenWithRawV(v1, [['00'.repeat(32), empty]])
    expect(cashbackValidation(bad)?.signatureValid).toBe(false)
    expect(cashbackValidation(tokenWithRawV(v1, []))?.signatureValid).toBe(false)
    expect(cashbackValidation(buildPlainToken('http://mint.test'))).toBeUndefined()
  })
})
