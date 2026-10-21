import { describe, expect, it } from 'vitest'
import { RedemptionRefusedError } from '@imani/dm-poll'

import { asFullyRedeemedRefusal } from '../dmPoll'
import { isVoucherFullyRedeemed, fullyRedeemedMessage, VOUCHER_FULLY_REDEEMED } from '../fullyRedeemed'
import { refusalMessage } from '../refusalToast'

/**
 * cashu-mint#540 phase 2, the till side: gateway-customer declared a home-coming coupon and the
 * mint refused it as redeemed in full. The receive answers 400 `VOUCHER_FULLY_REDEEMED`, which
 * `shared/api.js` surfaces as `error.code`. dm-poll must see a typed, TERMINAL refusal: retried, it
 * would be refused the same way on every poll.
 */
describe('a home-coming coupon refused as redeemed in full', () => {
  const VOUCHER = '1b6f3e2a-9c44-4f0b-8a21-3d5e6f7a8b9c'

  /** What `shared/api.js` throws for the gateway's 400. */
  function gatewayRefusal(): Error {
    const error = new Error('This coupon has already been redeemed in full.') as Error & Record<string, unknown>
    error.status = 400
    error.code = VOUCHER_FULLY_REDEEMED
    error.data = { error: { code: VOUCHER_FULLY_REDEEMED, details: '1b6f3e2a' } }
    return error
  }

  it('becomes a terminal fully-redeemed refusal carrying the reference', () => {
    const refusal = asFullyRedeemedRefusal(gatewayRefusal(), { voucherId: VOUCHER })

    expect(refusal).toBeInstanceOf(RedemptionRefusedError)
    expect((refusal as RedemptionRefusedError).reason).toBe('fully-redeemed')
    expect((refusal as RedemptionRefusedError).voucherId).toBe(VOUCHER)
    expect((refusal as Error).message).toBe(fullyRedeemedMessage(VOUCHER))
    expect((refusal as Error).message).toContain('reference 1b6f3e2a')
  })

  it('leaves every other failure untouched, so transient ones still retry', () => {
    const transient = Object.assign(new Error('Service Unavailable'), { status: 503, code: 'UNKNOWN_ERROR' })

    expect(asFullyRedeemedRefusal(transient, { voucherId: VOUCHER })).toBe(transient)
  })

  it('is matched on the code, from either the error or the gateway body', () => {
    expect(isVoucherFullyRedeemed({ code: VOUCHER_FULLY_REDEEMED })).toBe(true)
    expect(isVoucherFullyRedeemed({ data: { error: { code: VOUCHER_FULLY_REDEEMED } } })).toBe(true)
    expect(isVoucherFullyRedeemed({ error_code: VOUCHER_FULLY_REDEEMED })).toBe(true)
    expect(isVoucherFullyRedeemed(new Error('already been redeemed in full'))).toBe(false)
  })

  it('has words for the stall that say nothing was taken', () => {
    expect(refusalMessage('fully-redeemed')?.title).toBe('That coupon has already been redeemed in full')
    expect(refusalMessage('fully-redeemed')?.detail).toContain('Nothing was taken')
  })
})
