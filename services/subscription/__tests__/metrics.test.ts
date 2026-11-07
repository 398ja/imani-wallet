/**
 * @vitest-environment node
 *
 * Subscription metrics (#407), asserted on the RENDERED exposition text, which is what Prometheus
 * scrapes and Grafana queries (imani-deploy/docs/how-to/add-a-metric.md). Driven through the real
 * app: a Stripe webhook creates, cancels and reactivates; GET /metrics is read back.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'
import { beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.ts'
import type { SubscriptionConfig } from '../config.ts'
import { sellerFrom } from '../issuer.ts'
import { Ledger, type SubscriptionRow } from '../ledger.ts'
import { renderMetrics, resetMetricsForTest } from '../metrics.ts'
import { resetBusinessMetricsForTest } from '../businessMetrics.ts'
import { stripeSignatureHeader } from '../stripe.ts'

const SECRET = 'whsec_metrics'
const SELLER = sellerFrom(nip19.nsecEncode(generateSecretKey()))
const STALL = getPublicKey(generateSecretKey())
const CATALOG = (await readFile(join(__dirname, '..', 'catalog.json'), 'utf8')).trim()
const NOW = Date.UTC(2026, 9, 29, 15, 0) / 1000 // 2026-10-29 15:00 UTC
const DAY = 86_400

/** One sample from exposition text, or undefined when the series is absent. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`)
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue
    const [series, value] = [line.slice(0, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)]
    if (series.split('{')[0] !== name) continue
    if (want.every((w) => series.includes(w)) && want.length === (series.match(/="/g)?.length ?? 0)) return Number(value)
  }
  return undefined
}

let app: ReturnType<typeof createApp>
let ledger: Ledger
let clock = NOW * 1000

const metrics = async () => {
  const out = await app.handle({ method: 'GET', path: '/metrics', headers: {}, body: '' })
  expect(out.status).toBe(200)
  expect(out.headers?.['Content-Type']).toMatch(/^text\/plain; version=0\.0\.4/)
  return out.body as string
}

const webhook = (type: string, object: Record<string, unknown>) => {
  const body = JSON.stringify({ type, data: { object } })
  return app.handle({ method: 'POST', path: '/v1/stripe/webhook', body, headers: { 'stripe-signature': stripeSignatureHeader(body, SECRET, Math.floor(clock / 1000)) } })
}
const paid = (sub: string, invoice: string, tier: string, term = 'monthly') =>
  webhook('invoice.paid', {
    id: invoice,
    subscription: sub,
    customer: 'cus_m',
    amount_paid: 800,
    currency: 'gbp',
    subscription_details: { metadata: { stall_pubkey: STALL, tier, term } },
    lines: { data: [{ period: { start: Math.floor(clock / 1000), end: Math.floor(clock / 1000) + 30 * DAY } }] },
  })

beforeEach(async () => {
  resetMetricsForTest()
  resetBusinessMetricsForTest()
  clock = NOW * 1000
  ledger = new Ledger(join(await mkdtemp(join(tmpdir(), 'sub-metrics-')), 'ledger.json'))
  const config: SubscriptionConfig = {
    publicOrigin: 'https://subscription.test',
    basePath: '',
    walletUrl: 'http://gateway',
    edgeSecret: 'e',
    internalRelay: 'ws://relay',
    sellerNsec: '',
    stripeSecretKey: 'sk',
    stripeWebhookSecret: SECRET,
    prices: { 'basic:monthly': 'price_b', 'pro:annual': 'price_p' },
    adminPubkeys: [],
    ledgerPath: '',
    catalogPath: '',
    port: 0,
    automaticTax: true,
  }
  app = createApp({
    config,
    ledger,
    seller: SELLER,
    stripe: { createCheckout: async () => ({ id: 'cs', url: 'u' }), createPortal: async () => ({ url: 'u' }), getPrice: async () => ({ unitAmount: 800, currency: 'GBP' }) },
    catalogBody: CATALOG,
    // Minting fails here on purpose (no gateway): the ledger row is written first, which is what counts.
    issuer: { mint: async () => Promise.reject(new Error('no gateway')), deliver: async () => {}, revoke: async () => {} },
    merchantStanding: async () => 'merchant',
    notifier: { notify: async () => {} },
    now: () => clock,
    log: () => {},
  })
})

describe('GET /metrics on a service that has done nothing', () => {
  it('has every series already, at zero, so a quiet service is a zero and not an absence', async () => {
    const text = await metrics()
    for (const event of ['created', 'cancelled', 'reactivated']) {
      for (const tier of ['basic', 'pro', 'custom', 'other']) {
        expect(sample(text, 'imani_subscription_events_total', { event, tier, term: 'monthly' }), `${event} ${tier}`).toBe(0)
      }
    }
    for (const tier of ['basic', 'pro']) for (const status of ['active', 'cancelled', 'revoked']) expect(sample(text, 'imani_subscriptions', { tier, status, term: 'monthly', grant_kind: 'subscription' })).toBe(0)
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'created', tier: 'basic', day: '2026-10-29' })).toBe(0)
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'cancelled', tier: 'pro', day: '2026-09-30' })).toBe(0)
    expect(sample(text, 'imani_subscription_status_messages_total', { result: 'failed' })).toBe(0)
    expect(sample(text, 'imani_subscription_ledger_rows')).toBe(0)
    expect(text).toContain('# TYPE imani_subscription_events_total counter')
    expect(text).toContain('# TYPE imani_subscription_events_by_day gauge')
  })

  it('carries exactly 30 days, ending today (UTC), and no identifying label', async () => {
    const text = await metrics()
    const days = new Set([...text.matchAll(/day="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]))
    expect(days.size).toBe(30)
    expect([...days].sort()[0]).toBe('2026-09-30')
    expect([...days].sort()[29]).toBe('2026-10-29')
    expect(text).not.toContain(STALL)
    // Only closed label NAMES, and no identifier among the values.
    const labelNames = new Set([...text.matchAll(/[{,]([a-z_]+)="/g)].map((m) => m[1]))
    expect([...labelNames].sort()).toEqual(['currency', 'day', 'event', 'grant_kind', 'limit', 'result', 'source', 'state', 'status', 'term', 'tier'])
    expect([...text.matchAll(/="([^"]*)"/g)].map((m) => m[1]).filter((v) => /^(sub_|cus_|in_)|^[0-9a-f]{64}$/.test(v))).toEqual([])
  })
})

describe('created and cancelled, by tier, from the real webhook', () => {
  it('counts a new subscription once, not its renewals or a replay', async () => {
    await paid('sub_a', 'in_1', 'basic')
    await paid('sub_a', 'in_1', 'basic') // replay
    await paid('sub_a', 'in_2', 'basic') // renewal
    await paid('sub_b', 'in_3', 'pro', 'annual')
    const text = await metrics()
    expect(sample(text, 'imani_subscription_events_total', { event: 'created', tier: 'basic', term: 'monthly' })).toBe(1)
    expect(sample(text, 'imani_subscription_events_total', { event: 'created', tier: 'pro', term: 'annual' })).toBe(1)
    expect(sample(text, 'imani_subscriptions', { tier: 'basic', term: 'monthly', grant_kind: 'subscription', status: 'active' })).toBe(1)
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'created', tier: 'basic', day: '2026-10-29' })).toBe(1)
  })

  it('counts a cancellation (Stripe sends several events for one) once, and its undo as a reactivation', async () => {
    await paid('sub_a', 'in_1', 'pro', 'annual')
    clock += 2 * DAY * 1000 // cancelled two days later
    await webhook('customer.subscription.updated', { id: 'sub_a', status: 'active', cancel_at: Math.floor(clock / 1000) + 300 * DAY })
    await webhook('customer.subscription.updated', { id: 'sub_a', status: 'active', cancel_at: Math.floor(clock / 1000) + 300 * DAY, cancellation_details: {} })
    let text = await metrics()
    expect(sample(text, 'imani_subscription_events_total', { event: 'cancelled', tier: 'pro', term: 'annual' })).toBe(1)
    expect(sample(text, 'imani_subscriptions', { tier: 'pro', term: 'annual', grant_kind: 'subscription', status: 'cancelled' })).toBe(1)
    expect(sample(text, 'imani_subscriptions', { tier: 'pro', term: 'annual', grant_kind: 'subscription', status: 'active' })).toBe(0)
    // On the day it was cancelled, not the day it was created.
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'cancelled', tier: 'pro', day: '2026-10-31' })).toBe(1)
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'created', tier: 'pro', day: '2026-10-29' })).toBe(1)

    await webhook('customer.subscription.updated', { id: 'sub_a', status: 'active', cancel_at: null })
    text = await metrics()
    expect(sample(text, 'imani_subscription_events_total', { event: 'reactivated', tier: 'pro', term: 'annual' })).toBe(1)
    expect(sample(text, 'imani_subscriptions', { tier: 'pro', term: 'annual', grant_kind: 'subscription', status: 'active' })).toBe(1)
    // No longer cancelled, so it is not in the cancelled-per-day history.
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'cancelled', tier: 'pro', day: '2026-10-31' })).toBe(0)
  })
})

describe('the 30-day history comes from the ledger, so it survives restarts and Prometheus retention', () => {
  const row = (over: Partial<SubscriptionRow>): SubscriptionRow => ({
    subscriptionId: 'sub_x',
    stallPubkey: STALL,
    tier: 'basic',
    term: 'monthly',
    grantKind: 'subscription',
    status: 'active',
    paidAmountMinor: 800,
    paidCurrency: 'GBP',
    createdAt: NOW,
    licences: [],
    ...over,
  })

  it('places each row on its UTC day, drops anything older than 30 days, and files unknown tiers as other', () => {
    const text = renderMetrics(
      [
        row({ createdAt: NOW - 5 * DAY, tier: 'basic' }),
        row({ createdAt: NOW - 5 * DAY + 3600, tier: 'basic' }),
        row({ createdAt: NOW - 29 * DAY, tier: 'pro' }),
        row({ createdAt: NOW - 30 * DAY, tier: 'pro' }), // outside the window
        row({ createdAt: NOW - 40 * DAY, tier: 'pro', status: 'cancelled', cancelledAt: NOW - DAY }),
        row({ createdAt: NOW, tier: 'enterprise' }),
        row({ createdAt: NOW, tier: 'custom', grantKind: 'custom', status: 'revoked' }),
        row({ createdAt: NOW - 3 * DAY, status: 'cancelled' }), // cancelled before cancelledAt existed
      ],
      NOW,
    )
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'created', tier: 'basic', day: '2026-10-24' })).toBe(2)
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'created', tier: 'pro', day: '2026-09-30' })).toBe(1)
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'created', tier: 'pro', day: '2026-09-29' })).toBeUndefined()
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'cancelled', tier: 'pro', day: '2026-10-28' })).toBe(1)
    expect(sample(text, 'imani_subscription_events_by_day', { event: 'created', tier: 'other', day: '2026-10-29' })).toBe(1)
    expect(sample(text, 'imani_subscription_ledger_rows')).toBe(8)
  })
})
