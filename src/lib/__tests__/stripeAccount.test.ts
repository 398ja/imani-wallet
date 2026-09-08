/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  connectStripe,
  disconnectStripe,
  fetchStripeStatus,
  refreshStripe,
} from '../stripeAccount'

/**
 * Reading a stall's Stripe status.
 *
 * This decides whether a stall is published as taking cards, so the question
 * every test asks is the same: when the answer is anything other than a clear
 * yes, does it come back as no?
 */
function reply(status: number, body: unknown) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status })
}

describe('stripe account status', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'https://wallet.example' } as Location)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads a live account', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
      status: 'active',
      stripe_account_id: 'acct_1',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      default_currency: 'gbp',
      requirements_due: [],
    })))

    const result = await fetchStripeStatus()

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.status.chargesEnabled).toBe(true)
      expect(result.status.defaultCurrency).toBe('gbp')
    }
  })

  it('treats a missing or malformed charges flag as false', async () => {
    // The safe answer to "I do not know" is no. A truthy non-boolean reading as
    // enabled would publish a stall as taking cards it cannot take.
    for (const value of [undefined, null, 'true', 1, {}, 'yes']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
        status: 'active',
        charges_enabled: value,
      })))

      const result = await fetchStripeStatus()
      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') expect(result.status.chargesEnabled).toBe(false)
    }
  })

  it('survives a response that is not the shape we expect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, null)))

    const result = await fetchStripeStatus()

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.status.chargesEnabled).toBe(false)
      expect(result.status.requirementsDue).toEqual([])
    }
  })

  it('keeps only string requirements', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
      status: 'pending',
      charges_enabled: false,
      requirements_due: ['individual.id_number', 42, null, 'external_account'],
    })))

    const result = await fetchStripeStatus()
    if (result.kind === 'ok') {
      expect(result.status.requirementsDue).toEqual([
        'individual.id_number',
        'external_account',
      ])
    }
  })

  it('reports an expired session in words a merchant can act on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, {})))

    const result = await fetchStripeStatus()

    expect(result.kind).toBe('refused')
    if (result.kind === 'refused') expect(result.reason).toContain('session')
  })

  it('says nothing was changed when the service cannot be reached', async () => {
    // A merchant who thinks they half-connected an account goes looking for a
    // mess that is not there.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const result = await fetchStripeStatus()

    expect(result.kind).toBe('unreachable')
    if (result.kind === 'unreachable') expect(result.reason).toContain('Nothing was changed')
  })

  it('sends absolute return urls, because Stripe redirects a browser', async () => {
    // A relative path would resolve against stripe.com.
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { status: 'pending' }))
    vi.stubGlobal('fetch', fetchMock)

    await connectStripe()

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.return_url).toBe('https://wallet.example/settings/payments?stripe=return')
    expect(body.refresh_url).toBe('https://wallet.example/settings/payments?stripe=refresh')
  })

  it('carries the session cookie, which is the whole authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { status: 'active' }))
    vi.stubGlobal('fetch', fetchMock)

    await refreshStripe()

    expect(fetchMock.mock.calls[0][1].credentials).toBe('include')
  })

  it('reads a disconnect as a stall that takes no cards', async () => {
    // 204, no body. Not an error, and not a status either, so it has to be
    // turned into the one thing the caller can act on.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(204, null)))

    const result = await disconnectStripe()

    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.status.chargesEnabled).toBe(false)
      expect(result.status.status).toBe('not_connected')
    }
  })
})
