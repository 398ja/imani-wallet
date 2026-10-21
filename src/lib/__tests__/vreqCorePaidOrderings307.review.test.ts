import { describe, it, expect, vi, beforeEach } from 'vitest'

import { matchPayment, reconcileRequests, type VoucherPaymentRequest } from '../vreq'

/**
 * #307 review: the nastiest orderings for "one payment, counted once" once the till can mark a
 * sale Paid on gateway-core's verdict before its coupons reach the wallet (#300).
 *
 * Two sales of the SAME amount on one device. Sale B is paid on core's verdict and is waiting
 * for its coupons; sale A's coupon lands afterwards. Whatever order the coupons land in, stamped
 * or not, no arrival may settle the wrong sale, and no sale may be counted twice.
 */

const wallet = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('../wallet', () => ({ listTransactions: async () => wallet.rows }))

const stored = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  },
})

const createdAt = Date.now() - 60_000
const request = (over: Partial<VoucherPaymentRequest> = {}): VoucherPaymentRequest => ({
  paymentId: 'A',
  requestString: 'vreqA',
  clickableUri: 'cashu:vreqA',
  amount: 650,
  unit: 'GBP',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  createdAt,
  status: 'pending',
  ...over,
})
const saleA = () => request({ paymentId: 'A' })
const saleBPaidByCore = () =>
  request({ paymentId: 'B', status: 'fulfilled', confirmedBy: 'core', receivedAmount: 650 })

const arrival = (over: Partial<{ id: string; amount: number; paymentId: string }> = {}) => ({
  id: 'tx1',
  amount: 650,
  unit: 'GBP',
  at: createdAt + 1_000,
  direction: 'in' as const,
  ...over,
})

describe('two sales of the same amount, B paid by core first (#307 review)', () => {
  // A's coupon, stamped with A, lands after B was paid by core: it settles A, and B is untouched.
  it('a stamped coupon for A settles A, never B', () => {
    expect(matchPayment([saleA(), saleBPaidByCore()], arrival({ paymentId: 'A' }))).toMatchObject({
      paymentId: 'A',
      status: 'fulfilled',
      settledBy: 'tx1',
    })
  })

  // A's coupon lands WITHOUT a stamp. It may be A's or B's, so neither is settled with it: A keeps
  // waiting, and B is not "filed" with what may be A's money.
  it('an unstamped coupon of that amount settles neither', () => {
    expect(matchPayment([saleA(), saleBPaidByCore()], arrival())).toBeNull()
  })

  // B's own coupons land, stamped B, while A is still open: filed against B (no second count),
  // A stays open.
  it('B’s stamped coupons are filed against B, and never settle A', () => {
    expect(matchPayment([saleA(), saleBPaidByCore()], arrival({ paymentId: 'B' }))).toMatchObject({
      paymentId: 'B',
      status: 'fulfilled',
      confirmedBy: 'core',
      settledBy: 'tx1',
      receivedAmount: 650,
    })
  })

  // A second payment naming B after B's coupons were filed (the customer paid twice, or a replayed
  // DM with a fresh row) belongs to nobody: it must not fall through to the amount fallback and
  // mark A paid. Before #300 the fallback did exactly that for a wallet-settled request.
  it('a second payment naming an already-filed sale settles nothing else', () => {
    const filedB = { ...saleBPaidByCore(), settledBy: 'tx1' }
    expect(matchPayment([saleA(), filedB], arrival({ id: 'tx2', paymentId: 'B' }))).toBeNull()
  })

  // A coupon naming B that does not cover it (the first part of a chunked bundle) is not filed
  // yet, and is not offered to A either.
  it('a partial arrival naming B is neither filed against B nor given to A', () => {
    expect(matchPayment([saleA(), saleBPaidByCore()], arrival({ amount: 300, paymentId: 'B' }))).toBeNull()
  })
})

describe('reconcile over the full ordering (#307 review)', () => {
  const pubkey = 'r'.repeat(64)
  const key = `imani-wallet:payment-requests:${pubkey}`
  const read = () => JSON.parse(stored.get(key)!) as VoucherPaymentRequest[]
  const row = (id: string, at: number, requestId?: string) => ({
    id,
    type: 'received',
    timestamp: at,
    amount: 650,
    unit: 'GBP',
    ...(requestId ? { requestId } : {}),
  })

  beforeEach(() => {
    stored.clear()
    wallet.rows = []
  })

  // A's coupon lands unstamped first (ambiguous: nothing settles). Then B's stamped coupons land and
  // are filed against B. On the next wallet change A's arrival is unambiguous and settles A. Each
  // sale is counted once, by its own coupon, and nothing is counted twice however often it runs.
  it('unstamped A, then stamped B: B filed, then A settled, each once', async () => {
    stored.set(key, JSON.stringify([saleA(), saleBPaidByCore()]))
    wallet.rows = [row('txA', createdAt + 1_000)]
    await reconcileRequests(pubkey)
    expect(read().map((r) => [r.paymentId, r.status, r.settledBy])).toEqual([
      ['A', 'pending', undefined],
      ['B', 'fulfilled', undefined],
    ])

    wallet.rows = [row('txA', createdAt + 1_000), row('txB', createdAt + 2_000, 'B')]
    await reconcileRequests(pubkey)
    await reconcileRequests(pubkey)
    await reconcileRequests(pubkey)

    const [a, b] = read()
    expect(b).toMatchObject({ paymentId: 'B', status: 'fulfilled', confirmedBy: 'core', settledBy: 'txB' })
    expect(a).toMatchObject({ paymentId: 'A', status: 'fulfilled', settledBy: 'txA' })
    // One arrival per sale: no row settles two.
    expect(new Set(read().map((r) => r.settledBy)).size).toBe(2)
  })

  // Both sales paid on core's verdict, coupons unstamped: each is ambiguous, so neither is filed.
  // Paid stays on both, nothing is counted twice; the cost is only the "still receiving" note.
  it('both core-paid, unstamped coupons: nothing filed, nothing un-paid', async () => {
    const aPaid = { ...saleA(), status: 'fulfilled' as const, confirmedBy: 'core' as const, receivedAmount: 650 }
    stored.set(key, JSON.stringify([aPaid, saleBPaidByCore()]))
    wallet.rows = [row('tx1', createdAt + 1_000), row('tx2', createdAt + 2_000)]
    await reconcileRequests(pubkey)
    expect(read().map((r) => [r.status, r.settledBy])).toEqual([
      ['fulfilled', undefined],
      ['fulfilled', undefined],
    ])
  })
})
