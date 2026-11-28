import { describe, expect, it } from 'vitest'

import { reconcileInstalmentOffer } from '../instalmentOffer'
import type { MerchantProfile } from '../merchant'

const base: MerchantProfile = {
  pubkey: 'ab'.repeat(32),
  active: true,
  categories: [],
  issuanceCurrency: 'gbp',
  voucherValidityDays: 365,
  updatedAt: 0,
  acceptsCards: true,
  acceptsInstalments: true,
}

describe('reconcileInstalmentOffer', () => {
  it('leaves an eligible, offering stall alone', () => {
    expect(reconcileInstalmentOffer(base, { instalmentsEligible: true })).toEqual({ kind: 'unchanged' })
  })

  it('withdraws when the account is not eligible', () => {
    const change = reconcileInstalmentOffer(base, { instalmentsEligible: false })
    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') expect(change.merchant.acceptsInstalments).toBe(false)
  })

  it('changes nothing when the status could not be read', () => {
    expect(reconcileInstalmentOffer(base, null)).toEqual({ kind: 'unchanged' })
  })

  it('never turns the offer on by itself', () => {
    const off = { ...base, acceptsInstalments: false }
    expect(reconcileInstalmentOffer(off, { instalmentsEligible: true })).toEqual({ kind: 'unchanged' })
    expect(reconcileInstalmentOffer({ ...base, acceptsInstalments: undefined }, { instalmentsEligible: true })).toEqual({
      kind: 'unchanged',
    })
  })

  it('withdraws when cards are no longer offered', () => {
    const change = reconcileInstalmentOffer({ ...base, acceptsCards: false }, { instalmentsEligible: true })
    expect(change.kind).toBe('republish')
  })

  it('withdraws when sales are closed', () => {
    const change = reconcileInstalmentOffer({ ...base, salesClosed: true }, { instalmentsEligible: true })
    expect(change.kind).toBe('republish')
    if (change.kind === 'republish') expect(change.merchant.acceptsInstalments).toBe(false)
  })
})
