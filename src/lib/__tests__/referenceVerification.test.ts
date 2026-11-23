/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetReferenceVerificationCache,
  MAX_CONCURRENT_VERIFICATIONS,
  VERDICT_TTL_MS,
  verifyCardReference,
} from '../referenceVerification'

/**
 * Asking whether a card reference is a genuine payment to this stall's own
 * Stripe account. The one rule every test guards: only an explicit server
 * verdict may say "genuine" or "not genuine". Anything else is "could not
 * check", never a warning.
 */
function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

const PI = 'pi_3PqRsTuVwXyZ'

describe('verifyCardReference', () => {
  beforeEach(() => __resetReferenceVerificationCache())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is verified only when the server says so', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { result: 'verified', payment_intent_id: PI }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await verifyCardReference(PI)).toEqual({ kind: 'verified' })
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/merchant/stripe/payments/${PI}/verification`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' })
  })

  it.each(['mismatch', 'not_found'])('warns on %s', async (result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { result, detail: 'why' })))
    expect(await verifyCardReference(PI)).toEqual({ kind: 'failed', result, detail: 'why' })
  })

  it.each(['not_succeeded', 'not_connected', 'something_new'])('stays neutral on %s', async (result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { result })))
    expect((await verifyCardReference(PI)).kind).toBe('unknown')
  })

  it('stays neutral when the service fails or is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(502, {})))
    expect((await verifyCardReference(PI)).kind).toBe('unknown')
    __resetReferenceVerificationCache()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    expect((await verifyCardReference(PI)).kind).toBe('unknown')
  })

  it('never asks about something that is not a PaymentIntent id', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect((await verifyCardReference('../stripe/disconnect')).kind).toBe('unknown')
    expect((await verifyCardReference('5o190127tn364715t')).kind).toBe('unknown')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks PayPal about a PayPal capture id, with the same verdicts', async () => {
    // payment-adapter ADR 0002: a PayPal sale's warrant carries the capture id, and the stall's own
    // PayPal seller account is asked through merchant-service the same way Stripe is.
    const capture = '5O190127TN364715T'
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { result: 'refunded', payment_intent_id: capture, refunded_minor: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await verifyCardReference(capture)).toEqual({ kind: 'reversed', result: 'refunded', refundedMinor: 500 })
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/v1/merchant/paypal/payments/${capture}/verification`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' })
  })

  it('caches a final verdict but retries an unknown one', async () => {
    const ok = vi.fn().mockResolvedValue(reply(200, { result: 'verified' }))
    vi.stubGlobal('fetch', ok)
    await verifyCardReference(PI)
    await verifyCardReference(PI)
    expect(ok).toHaveBeenCalledTimes(1)

    const other = 'pi_other'
    const down = vi.fn().mockResolvedValue(reply(502, {}))
    vi.stubGlobal('fetch', down)
    await verifyCardReference(other)
    await verifyCardReference(other)
    expect(down).toHaveBeenCalledTimes(2)
  })

  it('reports a refund with its amount, not as genuine', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { result: 'refunded', refunded_minor: 500 })))
    expect(await verifyCardReference(PI)).toEqual({ kind: 'reversed', result: 'refunded', refundedMinor: 500 })
  })

  it('reports a dispute, not as genuine', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { result: 'disputed' })))
    expect(await verifyCardReference(PI)).toEqual({ kind: 'reversed', result: 'disputed' })
  })

  it('asks again once a cached verdict is five minutes old, so a later refund shows', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { result: 'verified' }))
      .mockResolvedValueOnce(reply(200, { result: 'refunded', refunded_minor: 1500 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(VERDICT_TTL_MS).toBe(5 * 60 * 1000)
    expect((await verifyCardReference(PI)).kind).toBe('verified')
    vi.advanceTimersByTime(VERDICT_TTL_MS - 1000)
    expect((await verifyCardReference(PI)).kind).toBe('verified')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect((await verifyCardReference(PI)).kind).toBe('reversed')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('caps how many references are asked about at once', async () => {
    const pending: Array<(r: Response) => void> = []
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)))
    vi.stubGlobal('fetch', fetchMock)
    expect(MAX_CONCURRENT_VERIFICATIONS).toBe(4)
    const answers = Array.from({ length: 6 }, (_, i) => verifyCardReference(`pi_row${i}`))
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    pending[0](reply(200, { result: 'verified' }))
    await answers[0]
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledTimes(5)
    for (let i = 1; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 0))
      pending[i]?.(reply(200, { result: 'verified' }))
    }
    await Promise.all(answers)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })
})
