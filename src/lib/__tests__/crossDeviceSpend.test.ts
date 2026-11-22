import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VoucherRow } from '@imani/wallet-storage'

// Two devices on one key share a relay and a mint. Each device has its own
// store; `device` selects which store `getWallet` returns.
const world = vi.hoisted(() => ({
  relay: [] as { tags: string[][]; content: string; created_at: number; kind: number; pubkey: string }[],
  mintSpent: new Set<string>(),
  stores: { A: new Map<string, VoucherRow>(), B: new Map<string, VoucherRow>() },
  device: 'A' as 'A' | 'B',
  mintDown: false,
}))

vi.mock('../nap', () => ({
  getSigner: () => ({ pubkey: 'aa'.repeat(32), nip44Encrypt: (_: string, p: string) => p, nip44Decrypt: (_: string, c: string) => c }),
}))
vi.mock('../relay', () => ({
  allEvents: async () => world.relay,
  allEventsWithGateway: async () => world.relay,
  eventsByD: async () => [],
  publish: async () => undefined,
}))
vi.mock('../legacyBridge', () => ({
  legacyApi: async () => ({
    validateToken: async (token: string) => {
      if (world.mintDown) throw new Error('down')
      return { state: world.mintSpent.has(token) ? 'SPENT' : 'UNSPENT' }
    },
  }),
}))
vi.mock('../wallet', () => ({
  addRestoredVoucher: async (row: VoucherRow) => {
    world.stores[world.device].set(row.token_id!, row)
    return row
  },
  getWallet: () => ({ getAllVouchers: async () => [...world.stores[world.device].values()] }),
  notifyWalletChanged: () => undefined,
  openWallet: async () => undefined,
  addRestoredTransaction: async () => undefined,
}))

import { pruneMintSpent, restoreVouchers } from '../voucherRecords'
import { spendable } from '../merchants'

const coupon = (id: string, amount = 21): VoucherRow =>
  ({ token_id: id, token: `cashuB${id}`, amount, status: 'active', issuer_id: 'cc'.repeat(32), created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' }) as VoucherRow

const record = (id: string, at: number, body: object, spent = false) => ({
  kind: 7375,
  pubkey: 'aa'.repeat(32),
  created_at: at,
  tags: [['d', id], ['spent', spent ? 'true' : 'false']],
  content: JSON.stringify(body),
})

const balance = (d: 'A' | 'B') => spendable([...world.stores[d].values()]).reduce((s, r) => s + (r.amount ?? 0), 0)

beforeEach(() => {
  world.relay = []
  world.mintSpent = new Set()
  world.stores = { A: new Map(), B: new Map() }
  world.mintDown = false
  // Both devices start holding the same two coupons, both backed up.
  for (const d of ['A', 'B'] as const) for (const id of ['c1', 'c2']) world.stores[d].set(id, coupon(id))
  world.relay.push(record('c1', 100, { voucher: coupon('c1') }), record('c2', 100, { voucher: coupon('c2') }))
})

describe('two devices, one key', () => {
  it('device B learns of a spend device A tombstoned, and the balances converge', async () => {
    // Device A spends c1: mint burns it, A tombstones it.
    world.mintSpent.add('cashuBc1')
    world.stores.A.set('c1', { ...coupon('c1'), status: 'spent' } as VoucherRow)
    world.relay.push(record('c1', 200, { spent: true }, true))
    expect(balance('A')).toBe(21)
    expect(balance('B')).toBe(42) // the reported bug

    world.device = 'B'
    world.mintDown = true // even without the mint, the tombstone alone converges
    await restoreVouchers('aa'.repeat(32))
    expect(world.stores.B.get('c1')?.status).toBe('spent')
    expect(balance('B')).toBe(balance('A'))
  })

  it('a spend whose tombstone never reached the relay is pruned via mint checkstate', async () => {
    world.mintSpent.add('cashuBc2') // A spent it; tombstone publish lost
    world.device = 'B'
    await restoreVouchers('aa'.repeat(32))
    expect(balance('B')).toBe(42)
    expect(await pruneMintSpent()).toBe(1)
    expect(world.stores.B.get('c2')?.status).toBe('spent')
    expect(balance('B')).toBe(21)
  })

  it('keeps every coupon when the mint cannot be reached', async () => {
    world.mintSpent.add('cashuBc2')
    world.mintDown = true
    world.device = 'B'
    expect(await pruneMintSpent()).toBe(0)
    expect(balance('B')).toBe(42)
  })

  it('leaves redeemed and swapped rows alone', async () => {
    world.device = 'B'
    world.stores.B.set('c1', { ...coupon('c1'), status: 'redeemed' } as VoucherRow)
    world.mintSpent.add('cashuBc1')
    world.relay.push(record('c1', 200, { spent: true }, true))
    await restoreVouchers('aa'.repeat(32))
    await pruneMintSpent()
    expect(world.stores.B.get('c1')?.status).toBe('redeemed')
  })
})
