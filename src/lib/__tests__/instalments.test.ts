/**
 * Monthly payments, the library (monthly payments spec, "Testing: Unit"): request shapes and
 * signed headers, the summary arithmetic, the purchase kind, status-to-chip for every adapter
 * status, and fail-closed parsing.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

import {
  PLANS_PATH,
  fetchStallInstalmentSummary,
  isRunning,
  isStripeCheckoutUrl,
  listInstalmentPlans,
  parsePlan,
  pastDue,
  planSummary,
  progressLabel,
  readInstalmentPlan,
  startInstalments,
  startRefusal,
  statusWords,
  stopInstalmentPlan,
  STOP_FAILED,
  type InstalmentPlan,
  type PlanStatus,
} from '../instalments'
import { PENDING_PURCHASE_KEY, rememberPurchase, rememberedPurchase, rememberedStall } from '../pendingPurchase'

const STALL = 'b'.repeat(64)
const BUYER = 'a'.repeat(64)

const sk = generateSecretKey()
const signer = { signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, sk) }

function plan(over: Partial<InstalmentPlan> = {}): InstalmentPlan {
  return {
    planId: 'p1',
    stallPubkey: STALL,
    status: 'ACTIVE',
    amountMinor: 4000,
    currency: 'gbp',
    totalInstalments: 6,
    instalmentsPaid: 3,
    cancelRequested: false,
    ...over,
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

function decodeAuth(init: RequestInit | undefined): { pubkey: string; tags: string[][] } {
  const header = (init?.headers as Record<string, string>).Authorization
  expect(header.startsWith('Nostr ')).toBe(true)
  return JSON.parse(atob(header.slice(6)))
}

describe('startInstalments', () => {
  it('posts the stall, buyer, amount and term, unsigned, and returns the Stripe page', async () => {
    fetchMock.mockResolvedValue(json(200, { checkoutUrl: 'https://checkout.stripe.com/c/x', planId: 'p1' }))

    const r = await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 4000, term: 6 })

    expect(r).toEqual({ kind: 'ok', checkoutUrl: 'https://checkout.stripe.com/c/x', planId: 'p1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/checkout/plan')
    expect(JSON.parse(init.body)).toEqual({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 4000, instalments: 6 })
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('leaves instalments out for a plan that runs until cancelled', async () => {
    fetchMock.mockResolvedValue(json(200, { checkoutUrl: 'https://checkout.stripe.com/c/x', planId: 'p1' }))

    await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 4000, term: 'open' })

    expect('instalments' in JSON.parse(fetchMock.mock.calls[0][1].body)).toBe(false)
  })

  // Regression: the adapter used to answer snake_case (checkout_url), which the wallet never read.
  it('does not accept a snake_case answer as a checkout URL', async () => {
    fetchMock.mockResolvedValue(json(200, { checkout_url: 'https://checkout.stripe.com/c/x', plan_id: 'p1' }))

    const r = await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 4000, term: 6 })

    expect(r.kind).toBe('error')
  })

  it('refuses a checkout URL that is not Stripe, so it is never an open redirect', async () => {
    fetchMock.mockResolvedValue(json(200, { checkoutUrl: 'https://checkout.stripe.com.evil.example/x', planId: 'p1' }))

    const r = await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 4000, term: 6 })

    expect(r.kind).toBe('error')
    expect(isStripeCheckoutUrl('http://checkout.stripe.com/x')).toBe(false)
    expect(isStripeCheckoutUrl('https://stripe.com/x')).toBe(true)
  })

  it('maps the below-minimum refusal with the adapter-named minimum', async () => {
    fetchMock.mockResolvedValue(json(400, { error: 'below', code: 'BELOW_MINIMUM', minAmountMinor: 2000 }))

    const r = await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 1000, term: 6 })

    expect(r).toEqual({ kind: 'error', refusal: { kind: 'below-minimum', minAmountMinor: 2000, reason: 'below' } })
  })

  it('says nothing was charged when the service cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'))

    const r = await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 4000, term: 6 })

    expect(r.kind === 'error' && r.refusal.reason).toMatch(/Nothing was charged/)
  })
})

describe('startRefusal', () => {
  it('words each code the spec names', () => {
    expect(startRefusal(404, { code: 'NOT_CONNECTED' }).reason).toBe("This stall doesn't offer monthly payments.")
    expect(startRefusal(409, { code: 'ACCOUNT_NOT_ELIGIBLE', error: 'x' }).reason).toBe("This stall can't take monthly payments yet.")
    expect(startRefusal(409, { error: 'this stall cannot accept card payments yet' }).reason).toBe(
      'This stall cannot accept card payments yet. Nothing was charged.',
    )
    expect(startRefusal(500, null).reason).toMatch(/could not be started/)
  })

  it('does not show an overlong upstream message', () => {
    expect(startRefusal(409, { error: 'x'.repeat(500) }).reason).toMatch(/could not be started/)
  })
})

describe('signed requests', () => {
  it('lists with a NIP-98 signature for the exact URL and verb, and no key in the query', async () => {
    fetchMock.mockResolvedValue(json(200, [{ planId: 'p1', stallPubkey: STALL, status: 'ACTIVE', amountMinor: 4000, currency: 'GBP' }]))

    const r = await listInstalmentPlans(signer)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(PLANS_PATH)
    expect(init.method).toBe('GET')
    const event = decodeAuth(init)
    expect(event.pubkey).toBe(getPublicKey(sk))
    expect(event.tags).toContainEqual(['u', `${window.location.origin}${PLANS_PATH}`])
    expect(event.tags).toContainEqual(['method', 'GET'])
    expect(r.kind === 'ok' && r.value[0].currency).toBe('gbp')
  })

  it('stops with a signed POST to the plan, carrying the empty-body payload tag', async () => {
    fetchMock.mockResolvedValue(json(200, { planId: 'p1', stallPubkey: STALL, status: 'ACTIVE', amountMinor: 4000, cancelRequested: true }))

    const r = await stopInstalmentPlan('p1', signer)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${PLANS_PATH}/p1/cancel`)
    expect(init.method).toBe('POST')
    const event = decodeAuth(init)
    expect(event.tags).toContainEqual(['method', 'POST'])
    expect(event.tags.some((t) => t[0] === 'payload')).toBe(true)
    expect(r.kind === 'ok' && r.value.cancelRequested).toBe(true)
  })

  it('reads a plan detail with its vouchers', async () => {
    fetchMock.mockResolvedValue(json(200, { plan: { planId: 'p1', stallPubkey: STALL, status: 'ACTIVE', amountMinor: 4000 }, voucherIds: ['v1', 7] }))

    const r = await readInstalmentPlan('p1', signer)

    expect(r.kind === 'ok' && r.value.voucherIds).toEqual(['v1'])
  })

  it('reads the stall summary signed for the stall query', async () => {
    fetchMock.mockResolvedValue(json(200, { activePlans: 7, monthlyTotals: [{ currency: 'gbp', amountMinor: 34000 }] }))

    const r = await fetchStallInstalmentSummary(STALL, signer)

    expect(fetchMock.mock.calls[0][0]).toBe(`${PLANS_PATH}/summary?stall=${STALL}`)
    expect(r).toEqual({ kind: 'ok', value: { activePlans: 7, monthlyTotals: [{ currency: 'gbp', amountMinor: 34000 }] } })
  })

  it('a Stripe failure on Stop says nothing was changed', async () => {
    fetchMock.mockResolvedValue(json(502, { error: 'could not reach Stripe to cancel; try again' }))

    expect(await stopInstalmentPlan('p1', signer)).toEqual({ kind: 'error', reason: STOP_FAILED })
  })

  it('an orphaned plan tells the buyer to ask the stall', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'this plan can no longer be managed here; ask the stall to cancel it in Stripe' }))

    const r = await stopInstalmentPlan('p1', signer)

    expect(r.kind === 'error' && r.reason).toMatch(/Ask them to stop it in Stripe/)
  })
})

describe('parsePlan', () => {
  it('drops a plan without an id, a valid stall or a positive amount', () => {
    expect(parsePlan({ stallPubkey: STALL, amountMinor: 1 })).toBeNull()
    expect(parsePlan({ planId: 'p', stallPubkey: 'nope', amountMinor: 1 })).toBeNull()
    expect(parsePlan({ planId: 'p', stallPubkey: STALL, amountMinor: 0 })).toBeNull()
    expect(parsePlan(null)).toBeNull()
  })

  it('reads an unknown status as UNKNOWN, which is never running or past due', () => {
    const p = parsePlan({ planId: 'p', stallPubkey: STALL, amountMinor: 1, status: 'TRIALING' })!
    expect(p.status).toBe('UNKNOWN')
    expect(isRunning(p)).toBe(false)
    expect(pastDue([p])).toEqual([])
  })

  it('reads a missing term as open-ended and a missing paid count as zero', () => {
    const p = parsePlan({ planId: 'p', stallPubkey: STALL, amountMinor: 1, status: 'ACTIVE' })!
    expect(p.totalInstalments).toBeNull()
    expect(p.instalmentsPaid).toBe(0)
    expect(p.cancelRequested).toBe(false)
  })
})

describe('words', () => {
  it('does the arithmetic for a fixed term and an open-ended plan', () => {
    expect(planSummary(4000, 'gbp', 6)).toBe(
      '£40 a month for 6 months, £240 in total. First payment today. A new voucher arrives with each payment.',
    )
    expect(planSummary(4000, 'gbp', 'open')).toBe('£40 a month until you cancel. First payment today.')
    expect(planSummary(2550, 'gbp', 3)).toMatch(/^£25\.50 a month for 3 months, £76\.50 in total/)
  })

  it('counts progress', () => {
    expect(progressLabel(plan())).toBe('3 of 6 paid')
    expect(progressLabel(plan({ totalInstalments: null }))).toBe('3 paid')
  })

  it('maps EVERY adapter status to a chip with words', () => {
    const all: PlanStatus[] = ['PENDING', 'ACTIVE', 'PAST_DUE', 'COMPLETED', 'CANCELLED', 'ORPHANED', 'ATTENTION', 'UNKNOWN']
    const chips = all.map((status) => statusWords(plan({ status })).chip)
    expect(chips).toEqual(['Not finished', 'Active', 'Payment failed', 'Finished', 'Cancelled', 'Needs the stall', 'Under review', 'Unknown'])
    for (const status of all) expect(statusWords(plan({ status })).meaning.length).toBeGreaterThan(0)
    expect(statusWords(plan({ status: 'COMPLETED' })).meaning).toBe('All 6 payments made.')
  })

  it('a plan the buyer stopped reads as stopped, not active', () => {
    expect(statusWords(plan({ cancelRequested: true })).meaning).toBe('Stopped. No further payments.')
    expect(isRunning(plan({ cancelRequested: true }))).toBe(false)
    expect(pastDue([plan({ status: 'PAST_DUE', cancelRequested: true })])).toEqual([])
  })
})

describe('pendingPurchase kind', () => {
  it('remembers a monthly purchase with its kind', () => {
    rememberPurchase(STALL, 'monthly')
    expect(rememberedPurchase()).toEqual({ stallPubkey: STALL, kind: 'monthly' })
    expect(rememberedStall()).toBe(STALL)
  })

  it('reads a record written before kinds existed as a one-off', () => {
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ stallPubkey: STALL }))
    expect(rememberedPurchase()).toEqual({ stallPubkey: STALL, kind: 'one-off' })
  })

  it('never trusts an unknown kind or a malformed stall', () => {
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ stallPubkey: STALL, kind: 'yearly' }))
    expect(rememberedPurchase()?.kind).toBe('one-off')
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ stallPubkey: 'x', kind: 'monthly' }))
    expect(rememberedPurchase()).toBeUndefined()
  })
})
