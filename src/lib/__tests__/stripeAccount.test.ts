/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StripeAccountStatus } from '../stripeAccount'
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

/**
 * A refused setup link must be distinguishable from no setup link.
 *
 * The allowlist that keeps `window.location.href` safe rejected stripe-mock's
 * `*.stripe.me` fixture URL — correctly — and reported it to nobody. Both cases
 * left `onboardingUrl` undefined, so pressing "Finish setting up" produced no
 * navigation, no message and no console line. A button that does nothing is the
 * worst failure it can have: there is nothing to search for.
 *
 * The rejection is CORRECT and stays. Only the silence is fixed.
 */
describe('a refused onboarding URL says so', () => {
  const statusWith = async (onboardingUrl: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'restricted', onboarding_url: onboardingUrl }),
      })),
    )
    const result = await connectStripe()
    expect(result.kind).toBe('ok')
    return (result as { status: StripeAccountStatus }).status
  }

  /*
   * The exact URL stripe-mock returns, which is how this was found.
   *
   * The first message here was technically perfect and practically useless:
   * "Refused a setup link that was not a Stripe address
   * (sangeekp-15t6ai--manage-mydev.dev.stripe.me)". It reads as a security
   * incident, names a host nobody recognises, and offers no next step — for a
   * situation where nothing is wrong and nothing can be done on this stack.
   *
   * So the mock is named, and the assertion is about what a reader LEARNS
   * rather than which branch ran.
   */
  it('explains the mock rather than reporting a scary refusal', async () => {
    const status = await statusWith(
      'https://sangeekp-15t6ai--manage-mydev.dev.stripe.me/setup/s/acct_1PgafTB7WZ01zgkW/x',
    )

    expect(status.onboardingUrl, 'must still refuse to navigate there').toBeUndefined()
    expect(status.onboardingUrlRejected).toContain('Stripe mock')
    // Says what still worked, so the reader does not go hunting a broken flow.
    expect(status.onboardingUrlRejected).toContain('Account creation worked')
    // And how to change it, which is the only actionable part.
    expect(status.onboardingUrlRejected).toContain('STRIPE_API_BASE')
    // The alarming phrasing is reserved for hosts that deserve it.
    expect(status.onboardingUrlRejected).not.toContain('Refused')
  })

  /* The phishing case the allowlist exists for. */
  it('refuses a lookalike host and says which one', async () => {
    const status = await statusWith('https://stripe.com.example.net/setup')

    expect(status.onboardingUrl).toBeUndefined()
    expect(status.onboardingUrlRejected).toContain('stripe.com.example.net')
  })

  it('refuses a non-https link', async () => {
    const status = await statusWith('http://stripe.com/setup')

    expect(status.onboardingUrl).toBeUndefined()
    expect(status.onboardingUrlRejected).toContain('https')
  })

  /*
   * The distinction that matters. Stripe sending nothing is not a refusal — it
   * is an account with nothing left to ask — and reporting it as an error would
   * put a scary message in front of a merchant who is finished.
   */
  it('reports no rejection when there was no link to refuse', async () => {
    const status = await statusWith(undefined)

    expect(status.onboardingUrl).toBeUndefined()
    expect(status.onboardingUrlRejected).toBeUndefined()
  })

  /* A good link still passes, unchanged. */
  it('accepts a real Stripe link and reports no rejection', async () => {
    const status = await statusWith('https://connect.stripe.com/setup/s/acct_123')

    expect(status.onboardingUrl).toBe('https://connect.stripe.com/setup/s/acct_123')
    expect(status.onboardingUrlRejected).toBeUndefined()
  })
})

/**
 * The friendly mock message must not become a hiding place.
 *
 * Naming `*.stripe.me` as "the mock, nothing is wrong" is safe only because it
 * is a SUFFIX check on the parsed hostname. A substring check would let
 * `stripe.me.attacker.com` describe itself as a local development mock —
 * turning a reassurance into cover for the exact attack the allowlist exists to
 * stop. Neither host is ever navigated to; the danger is only in the words.
 */
describe('the mock explanation cannot be borrowed', () => {
  const rejectionFor = async (onboardingUrl: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ status: 'restricted', onboarding_url: onboardingUrl }),
      })),
    )
    const result = await connectStripe()
    return (result as { status: StripeAccountStatus }).status
  }

  it.each([
    'https://stripe.me.attacker.com/setup',
    'https://evil-stripe.me.attacker.com/setup',
    'https://notstripe.me.example.net/setup',
  ])('calls %s a refusal, not a mock', async (url) => {
    const status = await rejectionFor(url)

    expect(status.onboardingUrl).toBeUndefined()
    expect(status.onboardingUrlRejected).toContain('not a Stripe address')
    expect(status.onboardingUrlRejected).not.toContain('mock')
  })

  /* A genuine mock host, including the bare domain, still gets the kind words. */
  it.each(['https://stripe.me/setup', 'https://x.dev.stripe.me/setup'])(
    'recognises %s as the mock',
    async (url) => {
      const status = await rejectionFor(url)

      expect(status.onboardingUrl).toBeUndefined()
      expect(status.onboardingUrlRejected).toContain('Stripe mock')
    },
  )
})
