import { describe, it, expect } from 'vitest'

import { expireRequests, matchPayment, type VoucherPaymentRequest } from '../vreq'

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
