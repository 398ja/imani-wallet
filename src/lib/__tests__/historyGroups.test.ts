import { describe, expect, it } from 'vitest'

import { groupHistory } from '../historyGroups'
import type { WalletTransaction } from '../transactions'

/**
 * A payment of several vouchers is one line in history (#106): the rows are
 * summed, never a declared figure, and nothing that is not the same payment
 * in the same currency is ever added to it.
 */

const tx = (id: string, over: Partial<WalletTransaction> = {}): WalletTransaction => ({
  id,
  type: 'received',
  direction: 'in',
  at: 1_000,
  amount: 300,
  unit: 'EUR',
  decimals: 2,
  ...over,
})

describe('groupHistory', () => {
  it('folds the rows of one bundle into one entry, summed from the rows', () => {
    const entries = groupHistory([
      tx('a', { bundleId: 'b1', at: 3_000 }),
      tx('b', { bundleId: 'b1', at: 2_000 }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'bundle', id: 'bundle:b1', amount: 600, at: 3_000 })
    if (entries[0]!.kind === 'bundle') expect(entries[0]!.parts.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('keeps list order: the group sits where its newest part would', () => {
    const entries = groupHistory([
      tx('x', { at: 9_000 }),
      tx('a', { bundleId: 'b1', at: 8_000 }),
      tx('y', { at: 7_000 }),
      tx('b', { bundleId: 'b1', at: 6_000 }),
    ])
    expect(entries.map((e) => (e.kind === 'single' ? e.tx.id : e.id))).toEqual(['x', 'bundle:b1', 'y'])
  })

  it('leaves a lone row, and rows with no bundle, exactly as they were', () => {
    const entries = groupHistory([tx('a', { bundleId: 'b1' }), tx('b'), tx('c')])
    expect(entries.every((e) => e.kind === 'single')).toBe(true)
    expect(entries).toHaveLength(3)
  })

  it('never adds across currencies, directions or kinds of movement', () => {
    const entries = groupHistory([
      tx('a', { bundleId: 'b1' }),
      tx('b', { bundleId: 'b1', unit: 'GBP' }),
      tx('c', { bundleId: 'b1', direction: 'out', type: 'sent' }),
    ])
    expect(entries).toHaveLength(3)
    expect(entries.every((e) => e.kind === 'single')).toBe(true)
  })

  it('groups a sender\u2019s sent rows the same way', () => {
    const entries = groupHistory([
      tx('a', { bundleId: 'b2', direction: 'out', type: 'sent' }),
      tx('b', { bundleId: 'b2', direction: 'out', type: 'sent' }),
    ])
    expect(entries).toEqual([expect.objectContaining({ kind: 'bundle', direction: 'out', amount: 600 })])
  })
})
