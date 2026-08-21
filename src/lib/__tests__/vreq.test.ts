import { readFileSync } from 'node:fs'

import { describe, it, expect } from 'vitest'
import { getDecimals } from '@imani/money'

import { formatFace } from '../format'
import {
  expireRequests,
  groupArrivals,
  matchPayment,
  partialFor,
  type VoucherPaymentRequest,
} from '../vreq'
import type { WalletTransaction } from '../transactions'

const request = (over: Partial<VoucherPaymentRequest> = {}): VoucherPaymentRequest => ({
  paymentId: 'p1',
  requestString: 'vreqA…',
  clickableUri: 'cashu:vreqA…',
  amount: 500,
  unit: 'EUR',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  createdAt: Date.now(),
  status: 'pending',
  ...over,
})

const payment = (
  over: Partial<{
    id: string
    amount: number
    unit: string
    paymentId: string
    at: number
    direction: 'in' | 'out'
  }> = {},
) => ({
  id: 'tx1',
  amount: 500,
  unit: 'EUR',
  // Later than the request, and incoming — a payment that settles a request is
  // always both. Tests that care override these.
  at: Date.now() + 1000,
  direction: 'in' as const,
  ...over,
})

describe('expireRequests', () => {
  it('expires a lapsed pending request', () => {
    const stale = request({ expiresAt: Math.floor(Date.now() / 1000) - 1 })
    expect(expireRequests([stale])[0].status).toBe('expired')
  })

  it('leaves a live one pending', () => {
    expect(expireRequests([request()])[0].status).toBe('pending')
  })

  it('never resurrects or re-expires a fulfilled request', () => {
    const paid = request({ status: 'fulfilled', expiresAt: Math.floor(Date.now() / 1000) - 1 })
    expect(expireRequests([paid])[0].status).toBe('fulfilled')
  })
})

describe('matchPayment', () => {
  it('matches on payment id', () => {
    const settled = matchPayment([request()], payment({ paymentId: 'p1' }))
    expect(settled?.status).toBe('fulfilled')
    expect(settled?.settledBy).toBe('tx1')
  })

  it('falls back to amount and unit when exactly one request matches', () => {
    const settled = matchPayment([request()], payment())
    expect(settled?.paymentId).toBe('p1')
  })

  it('refuses the amount fallback when two requests are equally plausible', () => {
    // Guessing here would mark the wrong sale paid, and the merchant would keep
    // waiting on one that has actually been settled.
    const two = [request(), request({ paymentId: 'p2' })]
    expect(matchPayment(two, payment())).toBeNull()
  })

  it('still resolves an ambiguous pair when the payment names its request', () => {
    const two = [request(), request({ paymentId: 'p2' })]
    expect(matchPayment(two, payment({ paymentId: 'p2' }))?.paymentId).toBe('p2')
  })

  it('accepts and records an overpayment', () => {
    const settled = matchPayment([request()], payment({ amount: 750 }))
    expect(settled?.status).toBe('fulfilled')
    expect(settled?.receivedAmount).toBe(750)
  })

  it('rejects an underpayment', () => {
    expect(matchPayment([request()], payment({ amount: 250 }))).toBeNull()
  })

  it('rejects a different unit', () => {
    expect(matchPayment([request()], payment({ unit: 'XAF' }))).toBeNull()
  })

  it('never settles a request twice with the same transaction', () => {
    // Without this the wallet re-notifying would settle a second request off one
    // payment, every time it fired.
    const already = request({ paymentId: 'p2', status: 'fulfilled', settledBy: 'tx1' })
    expect(matchPayment([request(), already], payment({ id: 'tx1' }))).toBeNull()
  })

  it('ignores non-pending requests', () => {
    expect(matchPayment([request({ status: 'expired' })], payment({ paymentId: 'p1' }))).toBeNull()
  })

  it('returns null when nothing is open — the common case', () => {
    expect(matchPayment([], payment())).toBeNull()
  })

  it('ignores a transaction that predates the request', () => {
    // The bug this rule exists for: RedeemPage sweeps the WHOLE transaction
    // history the moment a request is shown, so without it any older coupon of
    // the same unit and value settled the request instantly. The merchant never
    // saw the QR — the screen went straight to "Paid" for a sale nobody paid.
    const older = payment({ at: Date.now() - 60_000 })
    expect(matchPayment([request()], older)).toBeNull()
    expect(matchPayment([request()], { ...older, paymentId: 'p1' })).toBeNull()
  })

  it('ignores money leaving the wallet', () => {
    // A merchant issuing a 5 EUR coupon writes an outgoing row of exactly the
    // amount they are asking for — the likeliest false match of all.
    expect(matchPayment([request()], payment({ direction: 'out' }))).toBeNull()
  })

  it('ignores a transaction with no usable timestamp', () => {
    // toTransaction yields at=0 when the row carries no readable timestamp.
    // Unknown time fails closed: a request left pending makes a merchant wait,
    // a request wrongly marked paid makes them hand over goods for nothing.
    expect(matchPayment([request()], payment({ at: 0 }))).toBeNull()
  })
})

describe('groupArrivals', () => {
  const tx = (over: Partial<WalletTransaction> = {}): WalletTransaction =>
    ({
      id: 'tx1',
      type: 'received',
      direction: 'in',
      at: Date.now() + 1000,
      amount: 400,
      unit: 'EUR',
      decimals: 2,
      ...over,
    }) as WalletTransaction

  it('adds up the parts of one bundle, so a split payment settles its request', () => {
    // The whole point. €7 paid from a €4 and a €3 coupon arrives as two rows,
    // and each on its own is an underpayment `matchPayment` rejects — leaving
    // the merchant holding €7 and looking at a request that never settles.
    const arrivals = groupArrivals([
      tx({ id: 'tx1', amount: 400, bundleId: 'b1', paymentId: 'p1' }),
      tx({ id: 'tx2', amount: 300, bundleId: 'b1', paymentId: 'p1' }),
    ])

    expect(arrivals).toHaveLength(1)
    expect(arrivals[0].amount).toBe(700)
    expect(arrivals[0].parts).toBe(2)
    expect(arrivals[0].id).toBe('bundle:b1')
    expect(matchPayment([request({ amount: 700 })], arrivals[0])?.status).toBe('fulfilled')
  })

  it('dates a bundle by its earliest part', () => {
    // Rule 0 of matchPayment rejects anything that arrived before the request
    // was made. Taking the latest part would let a bundle whose first half
    // predates the request settle it.
    const early = Date.now() - 60_000
    const arrivals = groupArrivals([
      tx({ id: 'tx1', at: early, bundleId: 'b1' }),
      tx({ id: 'tx2', at: Date.now() + 1000, bundleId: 'b1' }),
    ])

    expect(arrivals[0].at).toBe(early)
    expect(matchPayment([request({ amount: 800 })], arrivals[0])).toBeNull()
  })

  it('refuses to add two currencies together', () => {
    // 400 EUR + 400 XAF is not 800 of anything, and a request settled off that
    // sum is goods handed over for half the price.
    const arrivals = groupArrivals([
      tx({ id: 'tx1', bundleId: 'b1' }),
      tx({ id: 'tx2', bundleId: 'b1', unit: 'XAF' }),
    ])

    expect(arrivals).toHaveLength(2)
    expect(arrivals.every((a) => a.amount === 400)).toBe(true)
  })

  it('leaves an ordinary single coupon exactly as it was', () => {
    const arrivals = groupArrivals([tx({ amount: 500 }), tx({ id: 'tx2', direction: 'out' })])

    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]).toMatchObject({ id: 'tx1', amount: 500, parts: 1 })
  })
})

describe('partialFor', () => {
  const arrival = (over: Record<string, unknown> = {}) => ({
    id: 'tx1',
    amount: 300,
    unit: 'EUR',
    at: Date.now() + 1000,
    direction: 'in' as const,
    paymentId: 'p1',
    parts: 1,
    ...over,
  })

  it('reports what has landed against a request that is not paid yet', () => {
    expect(partialFor(request(), [arrival()])).toBe(300)
  })

  it('counts only arrivals that name this request', () => {
    // By payment id ONLY: a part is smaller than the request by definition, so
    // an amount-based guess would show a merchant progress on a sale nobody is
    // paying for.
    expect(partialFor(request(), [arrival({ paymentId: undefined })])).toBe(0)
    expect(partialFor(request(), [arrival({ paymentId: 'p2' })])).toBe(0)
  })

  it('ignores anything that predates the request', () => {
    expect(partialFor(request(), [arrival({ at: Date.now() - 60_000 })])).toBe(0)
  })
})

/**
 * What the customer's side can and cannot learn from a request string.
 *
 * The generator is a classic script — `main.tsx` loads imani-apps'
 * shared/nut18v.js for its side effect on `window` — so the shim is loaded the
 * same way here rather than mocked. Mocking it would prove nothing: the whole
 * question is what the REAL encoder puts on the wire.
 */
describe('the NUT-18V wire format', () => {
  const shim = (() => {
    const scope = globalThis as unknown as { window?: unknown; NUT18V?: unknown }
    scope.window = scope
    new Function(readFileSync(new URL('../../../shared/nut18v.js', import.meta.url), 'utf8'))()
    return scope.NUT18V as {
      generate(o: { amount: number; unit: string; issuerId: string }): { requestString: string }
      parse(s: string): { amount: number; unit: string }
    }
  })()

  const roundTrip = (amount: number, unit: string) =>
    shim.parse(shim.generate({ amount, unit, issuerId: 'a'.repeat(64) }).requestString)

  it('carries minor units and NO decimals, so the reader must resolve them itself', () => {
    // The bug this pins: PayPage read `request.decimals ?? 0`, a field the
    // encoder never writes, and rendered a £1.00 request as "100 GBP" to every
    // customer without a coupon group to borrow decimals from.
    const parsed = roundTrip(100, 'GBP')

    expect(parsed.amount).toBe(100)
    expect('decimals' in parsed).toBe(false)
    expect(formatFace(parsed.amount, { unit: parsed.unit, decimals: getDecimals(parsed.unit) })).toBe(
      '£1.00',
    )
  })

  it('leaves a zero-decimal unit alone', () => {
    // The same lookup must NOT invent decimals: 100 sats is 100 sats. Intl says
    // 2 for SAT, which is why the currency registry answers this, not Intl.
    // (The word order is Intl's — see formatFace; only the scale matters here.)
    const parsed = roundTrip(100, 'SAT')

    expect(getDecimals(parsed.unit)).toBe(0)
    // Matched loosely: Intl separates with a non-breaking space.
    expect(formatFace(parsed.amount, { unit: parsed.unit, decimals: 0 })).toMatch(/^SAT\s100$/)
  })
})
