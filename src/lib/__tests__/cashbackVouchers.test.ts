/**
 * A cashback voucher on the merchant's Vouchers list learns it was claimed
 * (#144). The answer comes from the portal, asked only for rows that can still
 * change, and only when the list opens.
 */
import { describe, it, expect } from 'vitest'

import { cashbackClaimLabel, refreshCashbackClaims } from '../cashbackVouchers'
import type { CashbackStatusReading } from '../cashback'
import type { WalletTransaction } from '../transactions'

function cashbackRow(id: string, over: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    id: `cashback:${id}`,
    type: 'cashback',
    direction: 'out',
    at: 1,
    amount: 500,
    unit: 'EUR',
    decimals: 2,
    cashbackId: id,
    voucherId: `v-${id}`,
    ...over,
  }
}

describe('refreshing cashback claims', () => {
  /** An unclaimed row asks the portal and is relabelled Claimed when it says so. */
  it('relabels a claimed cashback as Claimed', async () => {
    // Arrange
    const rows = [cashbackRow('c1')]
    const written: Array<[string, CashbackStatusReading]> = []

    // Act
    await refreshCashbackClaims(rows, {
      fetchStatus: async () => ({ status: 'Claimed', claimedAt: 5 }),
      recordStatus: async (rowId, reading) => {
        written.push([rowId, reading])
      },
    })

    // Assert
    expect(written).toEqual([['cashback:c1', { status: 'Claimed', claimedAt: 5 }]])
    const relabelled = { ...rows[0], cashbackStatus: written[0][1].status }
    expect(cashbackClaimLabel(relabelled)).toBe('Claimed')
  })

  /** Settled rows and plain Sell rows are never asked about again. */
  it('asks only about cashback rows that can still change', async () => {
    // Arrange
    const asked: string[] = []
    const rows = [
      cashbackRow('settled', { cashbackStatus: 'Claimed' }),
      cashbackRow('open'),
      cashbackRow('nolink', { voucherId: undefined }),
      { ...cashbackRow('sale'), type: 'issued' as const, cashbackId: undefined },
    ]

    // Act
    await refreshCashbackClaims(rows, {
      fetchStatus: async (id) => {
        asked.push(id)
        return { status: 'Unclaimed' }
      },
      recordStatus: async () => {},
    })

    // Assert
    expect(asked).toEqual(['open'])
  })

  /** An Unclaimed answer is not persisted, so the row still reads as unchecked. */
  it('does not write back a non-terminal answer', async () => {
    // Arrange
    let writes = 0

    // Act
    await refreshCashbackClaims([cashbackRow('c1')], {
      fetchStatus: async () => ({ status: 'Unclaimed' }),
      recordStatus: async () => {
        writes += 1
      },
    })

    // Assert
    expect(writes).toBe(0)
  })
})

describe('the label', () => {
  /** A Sell voucher has no claim state from the portal, so no label. */
  it('says nothing for a non-cashback row', () => {
    expect(cashbackClaimLabel({ ...cashbackRow('x'), type: 'issued' })).toBeUndefined()
  })

  /** An unchecked cashback says Not claimed yet rather than guessing. */
  it('reads Not claimed yet until the portal says otherwise', () => {
    expect(cashbackClaimLabel(cashbackRow('x'))).toBe('Not claimed yet')
  })
})
