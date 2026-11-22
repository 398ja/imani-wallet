import { describe, expect, it } from 'vitest'

import { checkoutRefusalMessage, splitCheckoutRefusalMessage } from '../checkoutRefusal'

describe('checkoutRefusalMessage (#402)', () => {
  it('names the shop, not the vouchers, when its plan takes no new codes', () => {
    const text = checkoutRefusalMessage({ kind: 'refused', why: 'not_in_plan' })
    expect(text).toMatch(/not taking new checkout codes/)
    expect(text).toMatch(/still in your wallet/)
  })

  it('keeps the existing wording for every other refusal and for an abandoned code', () => {
    expect(checkoutRefusalMessage({ kind: 'refused', why: 'lock_refused' })).toBe('These vouchers cannot be used online right now. Nothing has changed.')
    expect(checkoutRefusalMessage({ kind: 'abandoned', why: 'not_in_plan' })).toMatch(/come back on their own/)
  })

  it('#644: appends the gateway reason when there is one', () => {
    expect(checkoutRefusalMessage({ kind: 'refused', why: 'lock_refused', detail: 'X' })).toBe('These vouchers cannot be used online right now. Nothing has changed. Reason given: X.')
  })

  it('#644: a refusal after a split says nothing was spent and never counts parts', () => {
    const text = splitCheckoutRefusalMessage({ why: 'lock_refused' })
    expect(text).toBe('No code could be made. Nothing was spent and your voucher is still in your wallet.')
    expect(splitCheckoutRefusalMessage({ why: 'lock_refused', detail: 'X' })).toMatch(/Reason given: X\.$/)
    expect(splitCheckoutRefusalMessage({ why: 'not_in_plan' })).toMatch(/not taking new checkout codes/)
  })
})
