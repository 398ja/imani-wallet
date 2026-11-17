import { describe, expect, it } from 'vitest'

import { checkoutRefusalMessage } from '../checkoutRefusal'

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
})
