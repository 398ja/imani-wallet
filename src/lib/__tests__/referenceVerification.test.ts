/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetReferenceVerificationCache, verifyCardReference } from '../referenceVerification'

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
  afterEach(() => vi.restoreAllMocks())

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
    expect(fetchMock).not.toHaveBeenCalled()
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
})
