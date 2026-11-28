/**
 * Weekly and yearly instalment plans, the library: term chips per interval, the words for each
 * interval (and that monthly keeps its own), the start body, the "not this often" refusal, the
 * summary totals per interval, plan parsing and the remembered purchase interval.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'

import {
  PLAN_TERMS,
  fetchStallInstalmentSettings,
  fetchStallInstalmentSummary,
  isMonthlyOnly,
  listWords,
  parseInterval,
  parsePlan,
  paymentsNoun,
  paymentsTitle,
  planSummary,
  planTerms,
  presetTerm,
  saveStallInstalmentSettings,
  startInstalments,
  startRefusal,
  statusWords,
  summaryLine,
  termLabel,
  type InstalmentPlan,
} from '../instalments'
import { PENDING_PURCHASE_KEY, rememberPurchase, rememberedPurchase } from '../pendingPurchase'

const STALL = 'b'.repeat(64)
const BUYER = 'a'.repeat(64)
const sk = generateSecretKey()
const signer = { signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, sk) }

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function plan(over: Partial<InstalmentPlan> = {}): InstalmentPlan {
  return {
    planId: 'p1',
    stallPubkey: STALL,
    status: 'ACTIVE',
    amountMinor: 1000,
    currency: 'gbp',
    interval: 'month',
    totalInstalments: 6,
    instalmentsPaid: 1,
    cancelRequested: false,
    ...over,
  }
}

describe('term chips', () => {
  it('offers chips per interval, each inside payment-adapter limits, with a preset among them', () => {
    expect(planTerms('week')).toEqual([4, 8, 12, 'open'])
    expect(planTerms('month')).toEqual([3, 6, 12, 'open'])
    expect(planTerms('year')).toEqual([2, 3, 5, 'open'])
    expect(planTerms()).toEqual(planTerms('month'))
    expect(PLAN_TERMS).toEqual(planTerms('month'))
    const max = { week: 52, month: 24, year: 5 } as const
    for (const i of ['week', 'month', 'year'] as const) {
      expect(planTerms(i)).toContain(presetTerm(i))
      for (const t of planTerms(i)) if (t !== 'open') expect(t >= 2 && t <= max[i]).toBe(true)
    }
    expect(presetTerm('week')).toBe(8)
    expect(presetTerm('month')).toBe(6)
    expect(presetTerm('year')).toBe(3)
  })

  it('labels a term in its own unit', () => {
    expect(termLabel(8, 'week')).toBe('8 weeks')
    expect(termLabel(6)).toBe('6 months')
    expect(termLabel(3, 'year')).toBe('3 years')
    expect(termLabel(1, 'year')).toBe('1 year')
    expect(termLabel('open', 'week')).toBe('Until I cancel')
  })
})

describe('interval words', () => {
  it('parses only known intervals, never guessing', () => {
    expect(parseInterval('week')).toBe('week')
    expect(parseInterval('year')).toBe('year')
    expect(parseInterval('day')).toBeNull()
    expect(parseInterval('WEEK')).toBeNull()
    expect(parseInterval(undefined)).toBeNull()
  })

  it('keeps "monthly payments" while everything is monthly, "regular payments" otherwise', () => {
    expect(isMonthlyOnly([])).toBe(true)
    expect(isMonthlyOnly(['month'])).toBe(true)
    // Review regression: a buyer with two monthly plans is still monthly-only.
    expect(isMonthlyOnly(['month', 'month'])).toBe(true)
    expect(isMonthlyOnly(['month', 'week'])).toBe(false)
    expect(isMonthlyOnly(['year'])).toBe(false)
    expect(paymentsNoun(['month', 'month'])).toBe('monthly payments')
    expect(paymentsTitle(['week'])).toBe('Regular payments')
  })

  it('joins words for a sentence', () => {
    expect(listWords([])).toBe('')
    expect(listWords(['weekly'])).toBe('weekly')
    expect(listWords(['weekly', 'yearly'])).toBe('weekly or yearly')
    expect(listWords(['weekly', 'monthly', 'yearly'])).toBe('weekly, monthly or yearly')
  })

  it('does the arithmetic in the interval the buyer chose', () => {
    expect(planSummary(1000, 'gbp', 8, 'week')).toBe(
      '£10 a week for 8 weeks, £80 in total. First payment today. A new voucher arrives with each payment.',
    )
    expect(planSummary(5000, 'gbp', 'open', 'year')).toBe('£50 a year until you cancel. First payment today.')
    // Monthly is unchanged.
    expect(planSummary(4000, 'gbp', 6)).toBe(
      '£40 a month for 6 months, £240 in total. First payment today. A new voucher arrives with each payment.',
    )
  })

  it('status words follow the plan interval, and a monthly plan keeps its own', () => {
    expect(statusWords(plan({ interval: 'week', status: 'PAST_DUE' })).meaning).not.toMatch(/monthly/i)
    expect(statusWords(plan({ status: 'UNKNOWN' })).meaning).toBe("We couldn't read this monthly payment's state.")
    expect(statusWords(plan({ interval: 'year', status: 'UNKNOWN' })).meaning).toBe("We couldn't read this payment's state.")
  })
})

describe('starting a plan', () => {
  const ok = () => json(200, { checkoutUrl: 'https://checkout.stripe.com/c/x', planId: 'p1' })

  it('sends the interval for weekly and yearly', async () => {
    fetchMock.mockResolvedValue(ok())
    await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 1000, term: 8, interval: 'week' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      stallPubkey: STALL,
      buyerPubkey: BUYER,
      amountMinor: 1000,
      instalments: 8,
      interval: 'week',
    })
  })

  it('leaves month out, so a monthly request is exactly what it was before intervals', async () => {
    fetchMock.mockResolvedValue(ok())
    await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 4000, term: 6, interval: 'month' })
    expect('interval' in JSON.parse(fetchMock.mock.calls[0][1].body)).toBe(false)
  })

  it('reads INTERVAL_NOT_OFFERED as what the stall takes now, in order', async () => {
    fetchMock.mockResolvedValue(json(400, { code: 'INTERVAL_NOT_OFFERED', intervals: ['year', 'week', 'day'] }))
    const r = await startInstalments({ stallPubkey: STALL, buyerPubkey: BUYER, amountMinor: 1000, term: 8, interval: 'month' })
    expect(r).toEqual({
      kind: 'error',
      refusal: {
        kind: 'interval-not-offered',
        intervals: ['week', 'year'],
        reason: 'This stall now takes weekly or yearly payments only. Choose again.',
      },
    })
  })

  it('a refusal naming nothing to choose from reads as not offered', () => {
    const r = startRefusal(400, { code: 'INTERVAL_NOT_OFFERED', intervals: ['day'] }, 'week')
    expect(r).toEqual({ kind: 'not-offered', reason: "This stall doesn't offer weekly payments." })
    expect(startRefusal(400, { code: 'INTERVAL_NOT_OFFERED' }, 'year').kind).toBe('not-offered')
  })
})

describe('plans and summary from the wire', () => {
  it('a plan without an interval is monthly, an unknown one too', () => {
    const base = { planId: 'p1', stallPubkey: STALL, status: 'ACTIVE', amountMinor: 1000, currency: 'GBP' }
    expect(parsePlan(base)?.interval).toBe('month')
    expect(parsePlan({ ...base, interval: 'fortnight' })?.interval).toBe('month')
    expect(parsePlan({ ...base, interval: 'week' })?.interval).toBe('week')
  })

  it('keeps one total per currency and interval, dropping unknown intervals', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        activePlans: 3,
        monthlyTotals: [{ currency: 'gbp', amountMinor: 4000 }],
        totals: [
          { currency: 'gbp', interval: 'month', amountMinor: 4000 },
          { currency: 'gbp', interval: 'week', amountMinor: 1000 },
          { currency: 'gbp', interval: 'day', amountMinor: 1 },
        ],
      }),
    )
    const r = await fetchStallInstalmentSummary(STALL, signer)
    expect(r.kind === 'ok' && r.value.totals).toEqual([
      { currency: 'gbp', interval: 'month', amountMinor: 4000 },
      { currency: 'gbp', interval: 'week', amountMinor: 1000 },
    ])
  })

  it('an adapter from before intervals: its monthly totals are the totals', async () => {
    fetchMock.mockResolvedValue(json(200, { activePlans: 1, monthlyTotals: [{ currency: 'gbp', amountMinor: 4000 }] }))
    const r = await fetchStallInstalmentSummary(STALL, signer)
    expect(r.kind === 'ok' && r.value.totals).toEqual([{ currency: 'gbp', interval: 'month', amountMinor: 4000 }])
  })

  it('summary line: monthly keeps its words, mixed never adds across intervals', () => {
    const monthly = { currency: 'gbp', amountMinor: 34000 }
    expect(summaryLine({ activePlans: 7, monthlyTotals: [monthly], totals: [{ ...monthly, interval: 'month' }] })).toBe(
      '7 people pay you monthly, £340 a month',
    )
    expect(summaryLine({ activePlans: 0, monthlyTotals: [], totals: [] })).toBe('0 people pay you monthly')
    expect(
      summaryLine({
        activePlans: 2,
        monthlyTotals: [{ currency: 'gbp', amountMinor: 4000 }],
        totals: [
          { currency: 'gbp', interval: 'month', amountMinor: 4000 },
          { currency: 'gbp', interval: 'week', amountMinor: 1000 },
        ],
      }),
    ).toBe('2 people pay you regularly, £40 a month + £10 a week')
    expect(
      summaryLine({ activePlans: 1, monthlyTotals: [], totals: [{ currency: 'gbp', interval: 'year', amountMinor: 5000 }] }),
    ).toBe('1 person pays you regularly, £50 a year')
  })

  it('summary line survives a summary without totals', () => {
    const legacy = { activePlans: 1, monthlyTotals: [{ currency: 'gbp', amountMinor: 4000 }] } as unknown as Parameters<
      typeof summaryLine
    >[0]
    expect(summaryLine(legacy)).toBe('1 person pays you monthly, £40 a month')
  })
})

describe('stall settings', () => {
  it('reads the offered intervals in order, dropping unknown ones', async () => {
    fetchMock.mockResolvedValue(json(200, { enabled: true, intervals: ['year', 'day', 'week'] }))
    expect(await fetchStallInstalmentSettings(STALL)).toEqual({ enabled: true, intervals: ['week', 'year'] })
  })

  it('saving without intervals sends none, so the server keeps what the stall offers', async () => {
    fetchMock.mockResolvedValue(json(200, { enabled: true, intervals: ['month'] }))
    await saveStallInstalmentSettings({ enabled: true }, signer)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: true })
  })

  it('saving with intervals sends them', async () => {
    fetchMock.mockResolvedValue(json(200, { enabled: true, intervals: ['week', 'month'] }))
    await saveStallInstalmentSettings({ enabled: true, intervals: ['week', 'month'] }, signer)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: true, intervals: ['week', 'month'] })
  })
})

describe('remembered purchase interval', () => {
  it('stores weekly and yearly, never month, and reads an old record as monthly', () => {
    rememberPurchase(STALL, 'monthly', 'week')
    expect(JSON.parse(sessionStorage.getItem(PENDING_PURCHASE_KEY) ?? '{}')).toEqual({ stallPubkey: STALL, kind: 'monthly', interval: 'week' })
    expect(rememberedPurchase()?.interval).toBe('week')

    rememberPurchase(STALL, 'monthly', 'month')
    expect(JSON.parse(sessionStorage.getItem(PENDING_PURCHASE_KEY) ?? '{}')).toEqual({ stallPubkey: STALL, kind: 'monthly' })
    expect(rememberedPurchase()?.interval).toBe('month')

    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ stallPubkey: STALL, kind: 'monthly', interval: 'day' }))
    expect(rememberedPurchase()?.interval).toBe('month')
  })

  it('a one-off has no interval, even if one is passed', () => {
    rememberPurchase(STALL, 'one-off', 'week')
    expect(JSON.parse(sessionStorage.getItem(PENDING_PURCHASE_KEY) ?? '{}')).toEqual({ stallPubkey: STALL, kind: 'one-off' })
    expect(rememberedPurchase()?.interval).toBeUndefined()
  })
})
