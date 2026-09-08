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

  it('only ever hands back a Stripe url to redirect to', async () => {
    // This value goes into window.location.href. An unchecked string from a
    // response is an open redirect: a merchant taps something they trust and
    // lands on a page asking for their bank details.
    const rejected = [
      'https://stripe.com.evil.example/onboard',   // looks like Stripe, is not
      'http://connect.stripe.com/setup',           // not https
      'javascript:alert(1)',
      '//connect.stripe.com/setup',
      'https://evil.example/stripe.com',
      'not a url',
    ]

    for (const onboarding_url of rejected) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
        status: 'pending',
        onboarding_url,
      })))
      const result = await fetchStripeStatus()
      if (result.kind === 'ok') {
        expect(result.status.onboardingUrl, onboarding_url).toBeUndefined()
      }
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
      status: 'pending',
      onboarding_url: 'https://connect.stripe.com/setup/abc',
    })))
    const accepted = await fetchStripeStatus()
    if (accepted.kind === 'ok') {
      expect(accepted.status.onboardingUrl).toBe('https://connect.stripe.com/setup/abc')
    }
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

/**
 * The refusal a merchant is shown must be the one the service gave.
 *
 * Every non-401 used to become "Stripe could not be reached through your
 * account", and the first time this screen met a real stack that sentence was
 * false: Stripe Connect was switched off, payment-adapter said so plainly
 * ("Stripe Connect is disabled"), and the wallet replaced it with a claim about
 * reachability. The investigation went to the network and the proxy table; the
 * answer was one unset flag in a compose file.
 */
describe('what a refusal actually says', () => {
  const connect = async (status: number, body: unknown, isJson = true) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status,
        json: async () => {
          if (!isJson) throw new SyntaxError('Unexpected token <')
          return body
        },
      })),
    )
    return connectStripe()
  }

  it('shows the service’s own message instead of a guess about the network', async () => {
    const result = await connect(502, { message: 'Stripe Connect is disabled' })
    expect(result).toEqual({ kind: 'refused', reason: 'Stripe Connect is disabled' })
  })

  /*
   * 401 keeps its own words: "session expired" is advice the merchant can act
   * on, and no upstream phrasing improves on it.
   */
  it('keeps the actionable wording for an expired session', async () => {
    const result = await connect(401, { message: 'NIP-98 authentication required' })
    expect(result).toEqual({
      kind: 'refused',
      reason: 'Your session has expired. Sign in again to manage card payments.',
    })
  })

  /*
   * A non-JSON body (an nginx error page, say) must not lose the refusal or
   * render markup. Falling back is right; throwing would turn a refusal into
   * "unreachable", which is the exact confusion this change removes.
   */
  it('falls back to the generic sentence when the body is not JSON', async () => {
    const result = await connect(500, null, false)
    expect(result.kind).toBe('refused')
    expect((result as { reason: string }).reason).toContain('Please try again')
  })

  /* An upstream that returns a stack trace must not become the screen. */
  it('refuses to render an unreasonably long upstream message', async () => {
    const result = await connect(502, { message: 'x'.repeat(500) })
    expect((result as { reason: string }).reason).toContain('Please try again')
  })

  /* A JSON body with no message at all is the same fallback. */
  it('falls back when the body carries no message', async () => {
    const result = await connect(502, { status: 502 })
    expect((result as { reason: string }).reason).toContain('Please try again')
  })
})
