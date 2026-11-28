/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  codeToWords,
  completeStripeOAuth,
  disconnectStripe,
  fetchStripeStatus,
  startStripeOAuth,
} from '../stripeAccount'

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status })
}

describe('monthly payments fields on the stripe status', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'https://wallet.example' } as Location)
  })
  afterEach(() => vi.restoreAllMocks())

  it('reads the five new fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
      status: 'active',
      charges_enabled: true,
      connection_type: 'OAUTH',
      fee_payer: 'account',
      losses_payer: 'account',
      instalments_eligible: true,
      active_plans: true,
    })))
    const result = await fetchStripeStatus()
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.status).toMatchObject({
      connectionType: 'OAUTH',
      feePayer: 'account',
      lossesPayer: 'account',
      instalmentsEligible: true,
      instalmentsEligibilityKnown: true,
      activePlans: true,
    })
  })

  it('fails closed on missing or malformed fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
      status: 'active',
      connection_type: 'SOMETHING',
      instalments_eligible: 'true',
      active_plans: 1,
    })))
    const result = await fetchStripeStatus()
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.status.connectionType).toBeUndefined()
    expect(result.status.instalmentsEligible).toBe(false)
    expect(result.status.instalmentsEligibilityKnown).toBe(false)
    expect(result.status.activePlans).toBe(false)
  })

  it('passes the refusal code through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(409, {
      status: 409, error: 'Conflict', message: 'Plans are running', code: 'ACTIVE_PLANS',
    })))
    const result = await disconnectStripe()
    expect(result).toMatchObject({ kind: 'refused', code: 'ACTIVE_PLANS', reason: 'Plans are running', status: 409 })
  })

  it('starts OAuth only toward Stripe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, {
      authorize_url: 'https://connect.stripe.com/oauth/authorize?x=1', expires_at: 'soon',
    })))
    expect(await startStripeOAuth()).toMatchObject({ kind: 'ok', authorizeUrl: 'https://connect.stripe.com/oauth/authorize?x=1' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(200, { authorize_url: 'https://evil.example/' })))
    expect((await startStripeOAuth()).kind).toBe('refused')
  })

  it('completes OAuth with one POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(502, { message: 'down', code: 'STRIPE_API_ERROR' }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await completeStripeOAuth('c', 's')
    expect(result).toMatchObject({ kind: 'refused', code: 'STRIPE_API_ERROR' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/merchant/stripe/oauth/complete')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: 'c', state: 's' })
  })
})

describe('codeToWords', () => {
  it('tells this merchant from another stall', () => {
    expect(codeToWords('MERCHANT_ALREADY_LINKED', 'Merchant already has an account')?.words).toBe(
      'You already have a Stripe account connected.',
    )
    expect(codeToWords('MERCHANT_ALREADY_LINKED', 'Account is already connected to another merchant')?.words).toBe(
      'That Stripe account is already connected to another stall.',
    )
  })

  it('maps the OAuth codes to Start again', () => {
    expect(codeToWords('OAUTH_STATE_INVALID')?.offer).toBe('start-again')
    expect(codeToWords('OAUTH_CODE_REJECTED')?.offer).toBe('start-again')
  })

  it('falls back for unknown codes', () => {
    expect(codeToWords('WHATEVER')).toBeNull()
    expect(codeToWords(undefined)).toBeNull()
  })
})
