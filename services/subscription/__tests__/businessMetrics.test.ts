/**
 * @vitest-environment node
 *
 * Subscription business metrics (business-metrics contract), asserted on the rendered text.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  BM_GRANT_KINDS,
  BM_LICENCE_STATES,
  BM_STATUSES,
  BM_TERMS,
  BM_TIERS,
  currencyDecimals,
  renderSubscriptionBusinessMetrics,
  resetBusinessMetricsForTest,
} from '../businessMetrics.ts'
import { Ledger, type IssuedLicence, type SubscriptionRow } from '../ledger.ts'

const NOW = 1_793_000_000
const STALL = 'c'.repeat(64)

const lic = (state: IssuedLicence['state']): IssuedLicence => ({ key: `in_${state}`, validFrom: 0, validTo: 1, state, attempts: 0 })
const row = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  subscriptionId: 'sub_0123456789abcdef',
  stallPubkey: STALL,
  stripeCustomerId: 'cus_SECRET',
  stripeSubscriptionId: 'sub_STRIPE',
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

function sample(text: string, name: string, labels: Record<string, string>): number | undefined {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`)
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{')) continue
    const series = line.slice(0, line.lastIndexOf(' '))
    if (series.split('{')[0] !== name) continue
    if (want.every((w) => series.includes(w)) && want.length === (series.match(/="/g)?.length ?? 0)) return Number(line.slice(line.lastIndexOf(' ') + 1))
  }
  return undefined
}

const render = (rows: SubscriptionRow[]) => renderSubscriptionBusinessMetrics(async () => rows, NOW)

beforeEach(() => resetBusinessMetricsForTest())

describe('imani_subscriptions', () => {
  it('binds every closed combination at zero on an empty ledger', async () => {
    const text = await render([])
    for (const tier of BM_TIERS)
      for (const term of BM_TERMS)
        for (const grant_kind of BM_GRANT_KINDS)
          for (const status of BM_STATUSES) expect(sample(text, 'imani_subscriptions', { tier, term, grant_kind, status })).toBe(0)
    for (const state of BM_LICENCE_STATES) expect(sample(text, 'imani_subscription_licences', { state })).toBe(0)
    expect(sample(text, 'imani_subscription_paid_value', { currency: 'GBP', tier: 'basic', term: 'monthly', status: 'active' })).toBe(0)
    expect(sample(text, 'imani_business_metrics_poll_failures_total', { source: 'subscription' })).toBe(0)
    expect(sample(text, 'imani_business_metrics_last_poll_seconds', { source: 'subscription' })).toBe(NOW)
  })

  it('counts each record once under its own tier, term, grant kind and status', async () => {
    const text = await render([
      row(),
      row(),
      row({ tier: 'pro', term: 'annual', status: 'cancelled' }),
      row({ tier: 'custom', term: 'custom', grantKind: 'custom', status: 'revoked', paidAmountMinor: 0 }),
      row({ tier: 'enterprise', status: 'paused' as SubscriptionRow['status'] }),
    ])
    expect(sample(text, 'imani_subscriptions', { tier: 'basic', term: 'monthly', grant_kind: 'subscription', status: 'active' })).toBe(2)
    expect(sample(text, 'imani_subscriptions', { tier: 'pro', term: 'annual', grant_kind: 'subscription', status: 'cancelled' })).toBe(1)
    expect(sample(text, 'imani_subscriptions', { tier: 'custom', term: 'custom', grant_kind: 'custom', status: 'revoked' })).toBe(1)
    expect(sample(text, 'imani_subscriptions', { tier: 'other', term: 'monthly', grant_kind: 'subscription', status: 'other' })).toBe(1)
    const total = [...text.matchAll(/^imani_subscriptions\{[^}]*\} (\d+)$/gm)].reduce((n, m) => n + Number(m[1]), 0)
    expect(total).toBe(5)
  })
})

describe('imani_subscription_paid_value', () => {
  it('sums the paid amount in major units per currency, tier, term and status', async () => {
    const text = await render([
      row({ paidAmountMinor: 800 }),
      row({ paidAmountMinor: 850 }),
      row({ tier: 'pro', term: 'annual', paidAmountMinor: 9600, paidCurrency: 'EUR' }),
      row({ paidAmountMinor: 1200, paidCurrency: 'JPY' }),
      row({ tier: 'custom', term: 'custom', grantKind: 'custom', paidAmountMinor: 0 }),
    ])
    expect(sample(text, 'imani_subscription_paid_value', { currency: 'GBP', tier: 'basic', term: 'monthly', status: 'active' })).toBe(16.5)
    expect(sample(text, 'imani_subscription_paid_value', { currency: 'EUR', tier: 'pro', term: 'annual', status: 'active' })).toBe(96)
    expect(sample(text, 'imani_subscription_paid_value', { currency: 'JPY', tier: 'basic', term: 'monthly', status: 'active' })).toBe(1200)
    expect(sample(text, 'imani_subscription_paid_value', { currency: 'GBP', tier: 'custom', term: 'custom', status: 'active' })).toBe(0)
    expect(currencyDecimals('BHD')).toBe(3)
  })

  it('collapses currencies past 40 into OTHER', async () => {
    const codes = Array.from({ length: 45 }, (_, i) => `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`)
    const text = await render(codes.map((c) => row({ paidCurrency: c, paidAmountMinor: 100 })))
    const currencies = new Set([...text.matchAll(/currency="([^"]+)"/g)].map((m) => m[1]))
    expect(currencies.size).toBe(41)
    expect(currencies.has('OTHER')).toBe(true)
    expect(sample(text, 'imani_subscription_paid_value', { currency: 'OTHER', tier: 'basic', term: 'monthly', status: 'active' })).toBe(6)
  })
})

describe('imani_subscription_licences', () => {
  it('counts licences across rows by state', async () => {
    const text = await render([row({ licences: [lic('delivered'), lic('delivered'), lic('owed')] }), row({ licences: [lic('failed'), lic('minted')] })])
    expect(sample(text, 'imani_subscription_licences', { state: 'delivered' })).toBe(2)
    expect(sample(text, 'imani_subscription_licences', { state: 'owed' })).toBe(1)
    expect(sample(text, 'imani_subscription_licences', { state: 'failed' })).toBe(1)
    expect(sample(text, 'imani_subscription_licences', { state: 'minted' })).toBe(1)
  })
})

describe('poll failure', () => {
  it('keeps the last values and counts the failure when the ledger cannot be read', async () => {
    await render([row(), row()])
    const text = await renderSubscriptionBusinessMetrics(async () => {
      throw new Error('corrupt')
    }, NOW + 60)
    expect(sample(text, 'imani_subscriptions', { tier: 'basic', term: 'monthly', grant_kind: 'subscription', status: 'active' })).toBe(2)
    expect(sample(text, 'imani_business_metrics_poll_failures_total', { source: 'subscription' })).toBe(1)
    expect(sample(text, 'imani_business_metrics_last_poll_seconds', { source: 'subscription' })).toBe(NOW)
  })

  it('a corrupt ledger file on disk reads as a failure, not as zero subscriptions', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'sub-bm-')), 'ledger.json')
    const ledger = new Ledger(path)
    await writeFile(path, JSON.stringify([row()]))
    await renderSubscriptionBusinessMetrics(() => ledger.all(), NOW)
    await writeFile(path, '{not json')
    const text = await renderSubscriptionBusinessMetrics(() => ledger.all(), NOW + 60)
    expect(sample(text, 'imani_subscriptions', { tier: 'basic', term: 'monthly', grant_kind: 'subscription', status: 'active' })).toBe(1)
    expect(sample(text, 'imani_business_metrics_poll_failures_total', { source: 'subscription' })).toBe(1)
  })
})

describe('exposition text', () => {
  it('is valid Prometheus text with one HELP and TYPE per family and no identifiers', async () => {
    const text = await render([row({ licences: [lic('delivered')] })])
    expect(text.endsWith('\n')).toBe(true)
    const types = new Map<string, string>()
    for (const line of text.trimEnd().split('\n')) {
      if (line.startsWith('# HELP ')) continue
      const t = /^# TYPE ([a-z_]+) (gauge|counter)$/.exec(line)
      if (t) {
        expect(types.has(t[1])).toBe(false)
        types.set(t[1], t[2])
        continue
      }
      expect(line).toMatch(/^[a-z_]+\{([a-z_]+="[^"\\]*",?)+\} -?\d+(\.\d+)?$/)
      expect(types.has(line.split('{')[0])).toBe(true)
    }
    expect(types.get('imani_business_metrics_poll_failures_total')).toBe('counter')
    for (const forbidden of [STALL, 'sub_0123456789abcdef', 'cus_SECRET', 'sub_STRIPE', 'in_delivered']) expect(text).not.toContain(forbidden)
  })
})
