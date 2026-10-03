import { describe, it, expect } from 'vitest'
import type { Voucher } from '@imani/voucher-send'
import type { PassedOver } from '@imani/wallet-core'
import { passedOverNote } from '../passedOverWording'

const v = {} as Voucher

describe('passedOverNote (#157)', () => {
  it('is silent when nothing sooner was passed over', () => {
    expect(passedOverNote([])).toBeNull()
  })

  it('explains one issuer exclusion', () => {
    expect(passedOverNote([{ voucher: v, reason: 'issuer' }])).toBe(
      'A voucher that expires sooner is not used: this merchant only accepts vouchers they issued.',
    )
  })

  it('counts several and lists each reason once', () => {
    const notes: PassedOver[] = [
      { voucher: v, reason: 'split' },
      { voucher: v, reason: 'unit' },
      { voucher: v, reason: 'split' },
    ]
    expect(passedOverNote(notes)).toBe(
      '3 vouchers that expire sooner are not used: cannot be divided to this amount, ' +
        'or wrong currency for this request.',
    )
  })
})
