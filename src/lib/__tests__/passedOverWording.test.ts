import { describe, it, expect } from 'vitest'
import type { Voucher } from '@imani/voucher-send'
import type { PassedOver } from '@imani/wallet-core'
import { passedOverNote } from '../passedOverWording'

const v = {} as Voucher

describe('passedOverNote (#157)', () => {
  it('is silent when nothing sooner was passed over', () => {
    expect(passedOverNote([])).toBeNull()
  })

  it('explains one issuer exclusion, in the customer word for the payee', () => {
    const note = passedOverNote([{ voucher: v, reason: 'issuer' }])
    expect(note).toBe(
      'A voucher that expires sooner is not used: this stall only accepts its own vouchers.',
    )
    // CONTEXT.md: "Merchant" must not cross into customer-facing text.
    expect(note).not.toMatch(/merchant/i)
  })

  it('does not call a coupon that is merely too small "cannot be divided"', () => {
    expect(passedOverNote([{ voucher: v, reason: 'small' }])).toBe(
      'A voucher that expires sooner is not used: it is worth less than this amount on its own.',
    )
  })

  it('counts several and lists each reason once', () => {
    const notes: PassedOver[] = [
      { voucher: v, reason: 'split' },
      { voucher: v, reason: 'unit' },
      { voucher: v, reason: 'split' },
    ]
    expect(passedOverNote(notes)).toBe(
      '3 vouchers that expire sooner are not used: they cannot be divided to this amount, ' +
        'or they are in another currency.',
    )
  })
})
