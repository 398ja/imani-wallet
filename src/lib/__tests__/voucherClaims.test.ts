import { describe, expect, it } from 'vitest'
import { claimEntries, pageOf, parsePage, recentClaims } from '../voucherClaims'
import { entryVoucherCount } from '../historyGroups'
import type { WalletTransaction } from '../transactions'

const tx = (id: string, at: number, extra: Partial<WalletTransaction> = {}): WalletTransaction =>
  ({ id, at, type: 'received', direction: 'in', amount: 100, unit: 'XAF', decimals: 0, voucherId: 'v1', merchantId: 'm', ...extra }) as WalletTransaction

describe('claimEntries', () => {
  it('folds rows sharing a bundle id into one record and leaves unbundled rows single', () => {
    const e = claimEntries([tx('a', 1), tx('b', 3, { bundleId: 'B' }), tx('c', 2, { bundleId: 'B' }), tx('d', 4)])
    expect(e.map((x) => x.kind)).toEqual(['single', 'bundle', 'single'])
    const b = e[1]!
    expect(b.kind === 'bundle' && b.amount).toBe(200)
  })
  it('counts each part as its own voucher, by token (#661)', () => {
    const e = claimEntries([tx('a', 2, { bundleId: 'B', tokenId: 't1' }), tx('b', 1, { bundleId: 'B', tokenId: 't2' })])
    expect(entryVoucherCount(e[0]!)).toBe(2)
    const same = claimEntries([tx('a', 2, { bundleId: 'B', tokenId: 't1' }), tx('b', 1, { bundleId: 'B', tokenId: 't1' })])
    expect(entryVoucherCount(same[0]!)).toBe(1)
  })
  it('sorts newest first regardless of input order', () => {
    const e = claimEntries([tx('old', 1), tx('new', 9)])
    expect(e[0]!.kind === 'single' && e[0]!.tx.id).toBe('new')
  })
})

describe('recentClaims', () => {
  const many = (n: number) => claimEntries(Array.from({ length: n }, (_, i) => tx(`t${i}`, i)))
  it('shows three and no link at exactly three', () => {
    expect(recentClaims(many(3))).toMatchObject({ hasMore: false })
    expect(recentClaims(many(3)).visible).toHaveLength(3)
  })
  it('caps at three and offers the link past three', () => {
    const r = recentClaims(many(4))
    expect(r.visible).toHaveLength(3)
    expect(r.hasMore).toBe(true)
  })
  it('counts a bundle as one record', () => {
    const e = claimEntries([tx('a', 1), tx('b', 2), tx('c', 3, { bundleId: 'B' }), tx('d', 4, { bundleId: 'B' })])
    expect(recentClaims(e).hasMore).toBe(false)
  })
})

describe('pagination', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => i)
  it('puts 21 records on a page', () => {
    expect(pageOf(items(21), 1)).toMatchObject({ pageCount: 1, outOfRange: false })
    expect(pageOf(items(22), 1).visible).toHaveLength(21)
    expect(pageOf(items(22), 2).visible).toEqual([21])
    expect(pageOf(items(42), 2)).toMatchObject({ pageCount: 2 })
    expect(pageOf(items(43), 3).pageCount).toBe(3)
  })
  it('flags a page past the end', () => {
    expect(pageOf(items(22), 3)).toMatchObject({ outOfRange: true, visible: [] })
  })
  it('an empty list is one empty page', () => {
    expect(pageOf([], 1)).toMatchObject({ pageCount: 1, outOfRange: false, total: 0 })
  })
  it('parses ?page= defensively', () => {
    expect(parsePage(null)).toBe(1)
    expect(parsePage('0')).toBe(1)
    expect(parsePage('-2')).toBe(1)
    expect(parsePage('abc')).toBe(1)
    expect(parsePage('2.5')).toBe(1)
    expect(parsePage('3')).toBe(3)
  })
})
