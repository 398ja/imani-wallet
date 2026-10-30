import { describe, expect, it } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'

import {
  CashlinkInvariantError,
  checkoutLockProposal,
  deriveCheckoutRefundSecret,
  deriveRefundSecret,
  isOpenAfterLocktime,
  isTheLockAskedFor,
  linkLockProposal,
  readLinkLock,
  xOnlyPub,
} from '../cashlinkLock'
import { voucherOfSecret } from '../voucherToken'
import { bearerSecret, signLocked } from './cashlinkWorld'

const ID = hexToBytes('44'.repeat(32))
const SHOP = xOnlyPub(hexToBytes('55'.repeat(32)))
const REFUND = deriveCheckoutRefundSecret(ID, 0)
const X = 1_800_600_000

const ask = { shopPub: SHOP, refundPub: xOnlyPub(REFUND), x: X, maxSats: 64, nonce: 'ab'.repeat(32) }

describe('checkoutLockProposal (#402 contract §2)', () => {
  it('locks to S with the link lock layout, byte for byte', () => {
    const gift = bearerSecret()
    const shop = checkoutLockProposal({ giftSecret: gift, ...ask })
    const link = linkLockProposal({ giftSecret: gift, linkPub: SHOP, refundPub: ask.refundPub, x: X, maxSats: 64, nonce: ask.nonce })
    expect(shop).toBe(link)
    expect(readLinkLock(shop)).toEqual({ linkPub: SHOP, refundPub: ask.refundPub, locktime: X })
    expect(isOpenAfterLocktime(shop)).toBe(false)
  })

  it('refuses R = S', () => {
    expect(() => checkoutLockProposal({ giftSecret: bearerSecret(), ...ask, refundPub: SHOP })).toThrow(CashlinkInvariantError)
    expect(() => checkoutLockProposal({ giftSecret: bearerSecret(), ...ask, refundPub: '02' + SHOP })).toThrow(/shop key/)
  })

  it('refuses what cannot be locked, as the link lock does', () => {
    const locked = checkoutLockProposal({ giftSecret: bearerSecret(), ...ask })
    expect(() => checkoutLockProposal({ ...ask, giftSecret: locked })).toThrow(/cannot be locked/)
    expect(() => checkoutLockProposal({ giftSecret: bearerSecret(), ...ask, x: 0 })).toThrow()
    expect(() => checkoutLockProposal({ giftSecret: bearerSecret(), ...ask, maxSats: 0 })).toThrow()
  })

  it('a signed part checks as asked for against S', () => {
    const gift = bearerSecret()
    const signed = signLocked(checkoutLockProposal({ giftSecret: gift, ...ask }))
    const v = voucherOfSecret(gift)!
    expect(isTheLockAskedFor(signed, v, { linkPub: SHOP, refundPub: ask.refundPub, x: X, maxSats: 64 })).toBe(true)
  })
})

describe('deriveCheckoutRefundSecret', () => {
  it('is deterministic, per part, and never a Cashlink refund key', () => {
    expect(deriveCheckoutRefundSecret(ID, 2)).toEqual(deriveCheckoutRefundSecret(ID, 2))
    expect(deriveCheckoutRefundSecret(ID, 2)).not.toEqual(deriveCheckoutRefundSecret(ID, 3))
    expect(deriveCheckoutRefundSecret(ID, 2)).not.toEqual(deriveRefundSecret(ID, 2))
    expect(xOnlyPub(deriveCheckoutRefundSecret(ID, 2))).not.toBe(xOnlyPub(ID))
    expect(() => deriveCheckoutRefundSecret(ID, -1)).toThrow()
  })
})
