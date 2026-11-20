import { describe, expect, it } from 'vitest'

import { entryKey, entryVoucherCount, groupHistory, worstValidation } from '../historyGroups'
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
    expect(entries[0]).toMatchObject({ kind: 'bundle', amount: 600, at: 3_000 })
    if (entries[0]!.kind === 'bundle') expect(entries[0]!.parts.map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('keeps list order: the group sits where its newest part would', () => {
    const entries = groupHistory([
      tx('x', { at: 9_000 }),
      tx('a', { bundleId: 'b1', at: 8_000 }),
      tx('y', { at: 7_000 }),
      tx('b', { bundleId: 'b1', at: 6_000 }),
    ])
    expect(entries.map((e) => (e.kind === 'single' ? e.tx.id : 'group'))).toEqual(['x', 'group', 'y'])
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

describe('review fixes', () => {
  it('never folds together rows from different counterparties under one bundle id', () => {
    const entries = groupHistory([
      tx('a', { bundleId: 'b1', counterparty: 'alice' }),
      tx('b', { bundleId: 'b1', counterparty: 'alice' }),
      tx('c', { bundleId: 'b1', counterparty: 'bob' }),
      tx('d', { bundleId: 'b1', counterparty: 'bob' }),
    ])
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => (e.kind === 'bundle' ? e.amount : 0))).toEqual([600, 600])
  })

  it('gives every group a unique key, even two sharing a bundle id', () => {
    const entries = groupHistory([
      tx('a', { bundleId: 'b1' }),
      tx('b', { bundleId: 'b1' }),
      tx('c', { bundleId: 'b1', type: 'cashback' }),
      tx('d', { bundleId: 'b1', type: 'cashback' }),
    ])
    const keys = entries.map(entryKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('carries the worst part validation onto the folded line', () => {
    const ok = { signatureValid: true } as never
    const bad = { signatureValid: false } as never
    expect(worstValidation([tx('a', { voucherId: 'v', validation: ok }), tx('b', { voucherId: 'w', validation: bad })])).toBe(bad)
    expect(worstValidation([tx('a'), tx('b')])).toBeUndefined()
  })
})

describe('entryVoucherCount: the folded line counts vouchers, not rows', () => {
  const M = 'f'.repeat(64)
  it('six rows of one voucher (a Cashlink take-back, one per proof) are 1 voucher', () => {
    const rows = [566, 283, 35, 9, 4, 1].map((amount, i) =>
      tx(`returned:r${i}`, { amount, bundleId: 'b1', merchantId: M, voucherId: 'v-one', tokenId: `r${i}` }),
    )
    const [entry] = groupHistory(rows)
    expect(entry!.kind).toBe('bundle')
    expect(entryVoucherCount(entry!)).toBe(1)
  })

  it('a payment drawn from two different vouchers is 2 vouchers', () => {
    const [entry] = groupHistory([
      tx('a', { bundleId: 'b2', merchantId: M, voucherId: 'v-a' }),
      tx('b', { bundleId: 'b2', merchantId: M, voucherId: 'v-b' }),
    ])
    expect(entryVoucherCount(entry!)).toBe(2)
  })

  it('a 5-part send drawn from ONE source voucher is 5 vouchers (staging: bundle read "1 voucher")', () => {
    const rows = [700, 500, 500, 400, 300].map((amount, i) =>
      tx(`sent:t${i}`, { type: 'sent', direction: 'out', amount, bundleId: 'b5', merchantId: M, voucherId: 'v-src', tokenId: `t${i}`, counterparty: 'r' }),
    )
    const [entry] = groupHistory(rows)
    expect(entry!.kind).toBe('bundle')
    expect(entryVoucherCount(entry!)).toBe(5)
  })

  it('5 received parts sharing one voucher id (stall paid with its own coupon) are 5 vouchers', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => tx(`received:t${n}`, { bundleId: 'b6', merchantId: M, voucherId: 'v-own', tokenId: `t${n}` }))
    expect(entryVoucherCount(groupHistory(rows)[0]!)).toBe(5)
  })

  it('rows with no voucher id are never merged into one', () => {
    const [entry] = groupHistory([tx('a', { bundleId: 'b3' }), tx('b', { bundleId: 'b3' })])
    expect(entryVoucherCount(entry!)).toBe(2)
  })
})
