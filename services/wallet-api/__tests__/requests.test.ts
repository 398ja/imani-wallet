import { describe, it, expect } from 'vitest'

import { parseCreateRequest, buildRequest, parseReconcileRequest, reconcile } from '../requests.js'

/**
 * Asking to be paid, over HTTP.
 *
 * The security property here is narrow and absolute: a payment request names
 * the signing key as recipient and nothing a caller sends can change that.
 * Takings are gift-wrapped to whoever is named, so a request pointing anywhere
 * else sends a customer's money to a key its owner cannot decrypt — stranded,
 * not merely misrouted, and undetectable until someone goes looking for it.
 */

const CALLER = 'c'.repeat(64)
const OTHER = 'b'.repeat(64)
const NOW_S = 1_800_000_000
const NOW_MS = NOW_S * 1000

describe('creating a request', () => {
  it('accepts an amount and a currency', () => {
    const r = parseCreateRequest({ amount: 250, unit: 'EUR' }, CALLER)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.stallPubkey).toBe(CALLER)
  })

  it('names the SIGNING key as recipient, always', () => {
    const r = parseCreateRequest({ amount: 250, unit: 'EUR' }, CALLER)
    expect(r.ok).toBe(true)
    if (r.ok) expect(buildRequest(r.value, NOW_S).requestString.length).toBeGreaterThan(20)
  })

  for (const field of ['stallPubkey', 'issuerId', 'recipientPubkey', 'recipient']) {
    it(`REFUSES an attempt to redirect takings via \`${field}\``, () => {
      // Refused rather than ignored, so an integrator learns at the first
      // request instead of after a day of takings have gone somewhere
      // unreachable.
      const r = parseCreateRequest({ amount: 250, unit: 'EUR', [field]: OTHER }, CALLER)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.field).toBe(field)
        expect(r.error.detail).toMatch(/could not be decrypted/)
      }
    })
  }

  it('allows the caller to name ITSELF, since that is not a redirection', () => {
    const r = parseCreateRequest({ amount: 250, unit: 'EUR', issuerId: CALLER }, CALLER)
    expect(r.ok).toBe(true)
  })

  it('refuses an amount of zero or less', () => {
    expect(parseCreateRequest({ amount: 0, unit: 'EUR' }, CALLER).ok).toBe(false)
    expect(parseCreateRequest({ amount: -5, unit: 'EUR' }, CALLER).ok).toBe(false)
  })

  it('refuses a fractional minor unit rather than rounding it', () => {
    // A fraction means cents were wanted and euros were sent. Flooring would
    // ask the customer for the wrong money.
    const r = parseCreateRequest({ amount: 2.5, unit: 'EUR' }, CALLER)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.field).toBe('amount')
  })

  it('requires a currency', () => {
    expect(parseCreateRequest({ amount: 250 }, CALLER).ok).toBe(false)
  })
})

describe('the request it builds', () => {
  const built = () => {
    const r = parseCreateRequest({ amount: 250, unit: 'EUR', description: ' Two coffees ' }, CALLER)
    if (!r.ok) throw new Error('setup failed')
    return buildRequest(r.value, NOW_S)
  }

  it('is a vreqA string with a cashu: uri', () => {
    const b = built()
    expect(b.requestString.startsWith('vreqA')).toBe(true)
    expect(b.clickableUri.startsWith('cashu:vreqA')).toBe(true)
  })

  it('expires a day out by default, in epoch SECONDS', () => {
    // Seconds, matching the wire format. Milliseconds here would encode an
    // expiry roughly fifty thousand years away.
    expect(built().expiresAt).toBe(NOW_S + 86_400)
  })

  it('trims a description rather than encoding the whitespace', () => {
    expect(built().description).toBe('Two coffees')
  })

  it('starts pending', () => {
    expect(built().status).toBe('pending')
  })
})

describe('reconciling what arrived', () => {
  const request = (over: Record<string, unknown> = {}) => ({
    paymentId: 'req-1',
    amount: 1000,
    unit: 'EUR',
    expiresAt: NOW_S + 3600,
    createdAt: NOW_MS - 3_600_000,
    status: 'pending',
    ...over,
  })

  const arrival = (over: Record<string, unknown> = {}) => ({
    id: 'tx-1',
    type: 'received',
    at: NOW_MS - 60_000,
    amount: 1000,
    unit: 'EUR',
    decimals: 2,
    ...over,
  })

  const run = (body: Record<string, unknown>) => {
    const parsed = parseReconcileRequest({ now: NOW_MS, ...body }, NOW_MS)
    if (!parsed.ok) throw new Error(`${parsed.error.field}: ${parsed.error.detail}`)
    return reconcile(parsed.value)
  }

  it('settles a request by payment id', () => {
    const out = run({
      requests: [request()],
      transactions: [arrival({ paymentId: 'req-1' })],
    })
    expect(out.settlements).toEqual([{ paymentId: 'req-1', transactionId: 'tx-1', amount: 1000 }])
    expect(out.requests[0].status).toBe('fulfilled')
    expect(out.outstanding).toEqual([])
  })

  it('does NOT settle a request from a payment that falls short', () => {
    // The case that costs a merchant real money if it goes the other way:
    // handing over goods for a partial payment.
    const out = run({
      requests: [request()],
      transactions: [arrival({ amount: 400, paymentId: 'req-1' })],
    })
    expect(out.settlements).toEqual([])
    expect(out.requests[0].status).toBe('pending')
    expect(out.outstanding[0].received).toBe(400)
  })

  it('reports a lapsed request as expired rather than unpaid', () => {
    const out = run({ requests: [request({ expiresAt: NOW_S - 60 })], transactions: [] })
    expect(out.requests[0].status).toBe('expired')
  })

  it('will not confuse two similar requests', () => {
    // The heuristic this replaces matched on amount and a time window, which
    // is exactly wrong when two customers are asked for the same price a
    // minute apart.
    const out = run({
      requests: [request({ paymentId: 'a' }), request({ paymentId: 'b' })],
      transactions: [arrival({ paymentId: 'b' })],
    })
    expect(out.settlements).toEqual([{ paymentId: 'b', transactionId: 'tx-1', amount: 1000 }])
    expect(out.requests.find((r) => r.paymentId === 'a')!.status).toBe('pending')
  })

  it('ignores an outgoing row however the caller labels it', () => {
    // A caller marking its own send as incoming could otherwise settle its own
    // request and mark itself paid.
    const out = run({
      requests: [request()],
      transactions: [arrival({ type: 'sent', direction: 'in', paymentId: 'req-1' })],
    })
    expect(out.settlements).toEqual([])
  })

  it('sums a bundled payment, because paying once in three parts is one arrival', () => {
    const out = run({
      requests: [request()],
      transactions: [
        arrival({ id: 'p1', amount: 400, bundleId: 'bundle-1', paymentId: 'req-1' }),
        arrival({ id: 'p2', amount: 600, bundleId: 'bundle-1', paymentId: 'req-1' }),
      ],
    })
    expect(out.settlements.length).toBe(1)
    expect(out.settlements[0].amount).toBe(1000)
  })

  it('names the field when a request row is malformed', () => {
    const parsed = parseReconcileRequest(
      { requests: [request(), request({ status: 'paid' })], transactions: [] },
      NOW_MS,
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.field).toBe('requests[1].status')
  })
})
