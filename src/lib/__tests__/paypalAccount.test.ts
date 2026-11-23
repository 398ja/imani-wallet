/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { connectPaypal, disconnectPaypal, fetchPaypalStatus, paypalUrlRejection, refreshPaypal } from '../paypalAccount'

/** A stall's PayPal seller account: `stripeAccount.test.ts`'s questions, asked of PayPal. */
function reply(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status })
}

describe('paypal account status', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'https://wallet.example' } as Location)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads a seller that can take cards, in the Stripe shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, {
      status: 'payouts_enabled',
      paypal_merchant_id: 'MERCH123',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      default_currency: 'gbp',
      requirements_due: [],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchPaypalStatus()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/merchant/paypal/status')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' })
    expect(result).toEqual({
      kind: 'ok',
      status: {
        status: 'payouts_enabled',
        stripeAccountId: 'MERCH123',
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        defaultCurrency: 'gbp',
        requirementsDue: [],
        onboardingUrl: undefined,
        onboardingUrlRejected: undefined,
      },
    })
  })

  it('never reads a malformed answer as able to charge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { charges_enabled: 'true' })))
    const result = await fetchPaypalStatus()
    expect(result.kind === 'ok' && result.status.chargesEnabled).toBe(false)
  })

  it('connects with a return URL on this origin and follows only a PayPal link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, {
      status: 'onboarding_in_progress',
      onboarding_url: 'https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=x',
    }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await connectPaypal()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/merchant/paypal/connect')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      return_url: 'https://wallet.example/settings/payments?paypal=return',
    })
    expect(result.kind === 'ok' && result.status.onboardingUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//)
  })

  it('refuses a setup link that is not PayPal’s, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
      status: 'onboarding_in_progress',
      onboarding_url: 'https://paypal.com.evil.example/x',
    })))
    const result = await connectPaypal()
    expect(result.kind === 'ok' && result.status.onboardingUrl).toBeUndefined()
    expect(result.kind === 'ok' && result.status.onboardingUrlRejected).toMatch(/not a PayPal address/)
    expect(paypalUrlRejection('http://www.paypal.com/x')).toMatch(/not https/)
    expect(paypalUrlRejection('https://paypal.com/x')).toBeNull()
  })

  it('refreshes with the same return URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { status: 'details_submitted' }))
    vi.stubGlobal('fetch', fetchMock)
    await refreshPaypal()
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/v1/merchant/paypal/refresh?return_url=${encodeURIComponent('https://wallet.example/settings/payments?paypal=return')}`,
    )
  })

  it('reads a disconnect as not connected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(204, null)))
    const result = await disconnectPaypal()
    expect(result.kind === 'ok' && result.status.status).toBe('not_connected')
  })

  it('shows the service’s own refusal, and nothing changed when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(403, { message: 'Upgrade your plan to connect PayPal.' })))
    expect(await connectPaypal()).toEqual({ kind: 'refused', reason: 'Upgrade your plan to connect PayPal.' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    expect((await fetchPaypalStatus()).kind).toBe('unreachable')
  })
})
