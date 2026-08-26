import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { TransactionRow } from '@imani/wallet-storage'

const stubs = vi.hoisted(() => ({ rows: [] as TransactionRow[] }))

vi.mock('../wallet', () => ({
  listTransactions: async () => stubs.rows,
}))

import { checkRedemption, redeemedTotal } from '../redemptionLedger'

const VOUCHER = '1d4410af-70f5-4c14-8606-519404684ea7'

const row = (over: Partial<Record<string, unknown>> = {}): TransactionRow =>
  ({
    id: `tx-${Math.random()}`,
    type: 'received',
    timestamp: 1_700_000_000_000,
    amount: 0,
    unit: 'GBP',
    decimals: 2,
    voucherId: VOUCHER,
    ...over,
  }) as unknown as TransactionRow

beforeEach(() => {
  stubs.rows = []
})

describe('redeemedTotal', () => {
  it('is zero when the voucher has never been seen', async () => {
    expect(await redeemedTotal(VOUCHER)).toBe(0)
  })

  it('sums repeat redemptions of a partially-spent voucher', async () => {
    // The legitimate case the schema calls out: one voucher, several tokens.
    stubs.rows = [row({ amount: 300 }), row({ amount: 250 })]
    expect(await redeemedTotal(VOUCHER)).toBe(550)
  })

  it('ignores other vouchers', async () => {
    stubs.rows = [row({ amount: 300 }), row({ amount: 999, voucherId: 'other' })]
    expect(await redeemedTotal(VOUCHER)).toBe(300)
  })

  it('counts only incoming rows', async () => {
    // Issuing the voucher and spending it are both outgoing. Counting them would
    // have the merchant exhaust a voucher's ceiling by minting it.
    stubs.rows = [
      row({ amount: 300 }),
      row({ amount: 1000, type: 'issued' }),
      row({ amount: 500, type: 'payment' }),
      row({ amount: 500, type: 'sent' }),
    ]
    expect(await redeemedTotal(VOUCHER)).toBe(300)
  })

  it('can exclude the redemption being checked', async () => {
    stubs.rows = [row({ id: 'tx-current', amount: 400 }), row({ amount: 100 })]
    expect(await redeemedTotal(VOUCHER, { excludeTransactionId: 'tx-current' })).toBe(100)
  })
})

describe('checkRedemption', () => {
  it('allows a redemption that fits', async () => {
    stubs.rows = [row({ amount: 300 })]
    const check = await checkRedemption({
      voucherId: VOUCHER,
      requested: 700,
      signedFaceValue: 1000,
    })
    expect(check).toMatchObject({ allowed: true, alreadyRedeemed: 300, remaining: 700 })
  })

  it('refuses the redemption that would breach the issued face value', async () => {
    // The attack a signature cannot see: the same genuine £10 voucher, presented
    // for £10 twice.
    stubs.rows = [row({ amount: 1000 })]
    const check = await checkRedemption({
      voucherId: VOUCHER,
      requested: 1000,
      signedFaceValue: 1000,
    })
    expect(check).toMatchObject({ allowed: false, alreadyRedeemed: 1000, remaining: 0 })
  })

  it('allows exactly the remaining balance', async () => {
    stubs.rows = [row({ amount: 600 })]
    const check = await checkRedemption({
      voucherId: VOUCHER,
      requested: 400,
      signedFaceValue: 1000,
    })
    expect(check.allowed).toBe(true)
  })

  it('never reports negative remaining', async () => {
    // Over-redeemed already, e.g. rows restored from before this check existed.
    stubs.rows = [row({ amount: 1500 })]
    const check = await checkRedemption({
      voucherId: VOUCHER,
      requested: 1,
      signedFaceValue: 1000,
    })
    expect(check.remaining).toBe(0)
    expect(check.allowed).toBe(false)
  })

  it('does not refuse a voucher that carries no signed face value', async () => {
    // Legacy derive-only tokens store faceValue 0. Inventing a ceiling for them
    // would refuse honest coupons; there is simply nothing to enforce.
    stubs.rows = [row({ amount: 5000 })]
    const check = await checkRedemption({
      voucherId: VOUCHER,
      requested: 5000,
      signedFaceValue: 0,
    })
    expect(check.allowed).toBe(true)
  })
})
