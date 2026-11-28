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
  SETTINGS_PATH,
  fetchStallInstalmentSettings,
  fetchStallInstalmentSummary,
  saveStallInstalmentSettings,
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
    interval: 'month',
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

  // A stall that switched off (enforced by payment-adapter) reads as "doesn't offer", never as an error.
  it('words NOT_OFFERED as a stall that does not offer them', () => {
    expect(startRefusal(409, { code: 'NOT_OFFERED', error: 'x' })).toEqual({ kind: 'not-offered', reason: "This stall doesn't offer monthly payments." })
    expect(startRefusal(409, { code: 'NOT_OFFERED' }, 'week').reason).toBe("This stall doesn't offer regular payments.")
  })

  // The stall changed how often it takes payments while the form was open: say what it takes now,
  // in the chooser's order, and carry it so the form can offer exactly those.
  it('words INTERVAL_NOT_OFFERED with what the stall takes now', () => {
    expect(startRefusal(409, { code: 'INTERVAL_NOT_OFFERED', intervals: ['year', 'week', 'day'] }, 'month')).toEqual({
      kind: 'interval-not-offered',
      intervals: ['week', 'year'],
      reason: 'This stall now takes weekly or yearly payments only. Choose again.',
    })
    // Nothing named to choose from: read as not offered (review fix), never an empty choice.
    expect(startRefusal(409, { code: 'INTERVAL_NOT_OFFERED' }, 'year')).toEqual({
      kind: 'not-offered',
      reason: "This stall doesn't offer yearly payments.",
    })
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
    // An adapter from before intervals: its monthly totals are its totals.
    expect(r).toEqual({
      kind: 'ok',
      value: {
        activePlans: 7,
        monthlyTotals: [{ currency: 'gbp', amountMinor: 34000 }],
        totals: [{ currency: 'gbp', interval: 'month', amountMinor: 34000 }],
      },
    })
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
    // A record of a monthly plan reads back as monthly; the stored record is what it always was.
    expect(rememberedPurchase()).toEqual({ stallPubkey: STALL, kind: 'monthly', interval: 'month' })
    expect(JSON.parse(sessionStorage.getItem(PENDING_PURCHASE_KEY) ?? '{}')).toEqual({ stallPubkey: STALL, kind: 'monthly' })
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

describe('stall instalment settings', () => {
  it('saves signed by the stall, the payload tag covering exactly the body sent', async () => {
    fetchMock.mockResolvedValue(json(200, { enabled: true, intervals: ['month'] }))

    const r = await saveStallInstalmentSettings({ enabled: true }, signer)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(SETTINGS_PATH)
    expect(init.method).toBe('POST')
    // Intervals left out: the server keeps the stall's own, so this switch never erases them.
    expect(JSON.parse(init.body)).toEqual({ enabled: true })
    const event = decodeAuth(init)
    expect(event.pubkey).toBe(getPublicKey(sk))
    expect(event.tags).toContainEqual(['u', `${window.location.origin}${SETTINGS_PATH}`])
    expect(event.tags).toContainEqual(['method', 'POST'])
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(init.body))
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(event.tags).toContainEqual(['payload', hex])
    expect(r).toEqual({ kind: 'ok', value: { enabled: true, intervals: ['month'] } })
  })

  it('sends intervals only when given', async () => {
    fetchMock.mockResolvedValue(json(200, { enabled: true, intervals: ['week', 'month'] }))
    await saveStallInstalmentSettings({ enabled: true, intervals: ['week', 'month'] }, signer)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: true, intervals: ['week', 'month'] })
  })

  it('a refused or unreachable save is an error, never ok', async () => {
    fetchMock.mockResolvedValue(json(401, { error: 'NIP-98 authorization required' }))
    expect((await saveStallInstalmentSettings({ enabled: true }, signer)).kind).toBe('error')
    fetchMock.mockResolvedValue(json(400, { error: 'bad' }))
    expect((await saveStallInstalmentSettings({ enabled: true }, signer)).kind).toBe('error')
    fetchMock.mockRejectedValue(new TypeError('network'))
    expect((await saveStallInstalmentSettings({ enabled: false }, signer)).kind).toBe('error')
  })

  it('reads the public offer, dropping unknown intervals; null when it cannot be read', async () => {
    fetchMock.mockResolvedValue(json(200, { enabled: true, intervals: ['week', 'day', 'month'] }))
    expect(await fetchStallInstalmentSettings(STALL)).toEqual({ enabled: true, intervals: ['week', 'month'] })
    expect(fetchMock.mock.calls[0][0]).toBe(`${SETTINGS_PATH}?stall=${STALL}`)
    fetchMock.mockResolvedValue(json(503, {}))
    expect(await fetchStallInstalmentSettings(STALL)).toBeNull()
    fetchMock.mockRejectedValue(new TypeError('network'))
    expect(await fetchStallInstalmentSettings(STALL)).toBeNull()
  })
})
