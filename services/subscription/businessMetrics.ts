/**
 * Business metrics for subscriptions (business-metrics contract, 2026-11-05), re-derived from the
 * sales ledger (`/data/ledger.json`, ledger.ts) on every scrape. Reading a few hundred JSON rows is
 * cheap, and a scrape always shows the ledger as it is now, so it is restart-safe state, not a
 * counter that resets on deploy.
 *
 * Series (label values exactly as the ledger stores them, lower-case):
 *  - `imani_subscriptions{tier,term,grant_kind,status}`: subscription records.
 *  - `imani_subscription_paid_value{currency,tier,term,status}`: sum of `paidAmountMinor` in MAJOR
 *    units of `paidCurrency`. The ledger keeps the LATEST invoice's amount per subscription (a
 *    renewal overwrites it), so this is what each subscription last paid, not lifetime revenue.
 *    A hand grant pays 0.
 *  - `imani_subscription_licences{state}`: licences across all rows by delivery state.
 *  - `imani_business_metrics_poll_failures_total{source="subscription"}` and
 *    `imani_business_metrics_last_poll_seconds{source="subscription"}`.
 *
 * Closed sets, from the `SubscriptionRow` type: tier basic|pro|custom|other (catalog tiers plus a
 * hand grant; anything else is `other`), term monthly|annual|custom|other, grant_kind
 * subscription|custom|other, status active|cancelled|revoked|other, licence state
 * owed|minted|delivered|failed|other. Currency is the upper-case ISO code, at most 40 distinct, then
 * `OTHER` (a currency label is the exception to "lower-case": ISO codes are upper-case, as the
 * ledger stores them). Never a subscription id, stall pubkey, Stripe id or amount as a label.
 *
 * A ledger that cannot be read keeps the last values and counts the failure, so a corrupt file
 * reads as a stale number with an alertable counter, not as "no subscriptions".
 */
import type { SubscriptionRow } from './ledger.ts'

export const BM_SOURCE = 'subscription'
export const BM_TIERS = ['basic', 'pro', 'custom', 'other'] as const
export const BM_TERMS = ['monthly', 'annual', 'custom', 'other'] as const
export const BM_GRANT_KINDS = ['subscription', 'custom', 'other'] as const
export const BM_STATUSES = ['active', 'cancelled', 'revoked', 'other'] as const
export const BM_LICENCE_STATES = ['owed', 'minted', 'delivered', 'failed', 'other'] as const
export const MAX_CURRENCIES = 40
/** Bound before any sale, so the paid-value panel reads zero rather than no data. */
const DEFAULT_CURRENCY = 'GBP'

const closed = <T extends readonly string[]>(set: T, v: unknown): T[number] =>
  typeof v === 'string' && (set as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T[number]) : ('other' as T[number])

/** ISO 4217 minor digits, from the runtime's currency data; 2 when unknown. */
export function currencyDecimals(code: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

const key = (...parts: string[]) => parts.join('|')
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

interface Snapshot {
  subscriptions: Map<string, number>
  paid: Map<string, number>
  licences: Map<string, number>
  currencies: string[]
}

let last: Snapshot | null = null
let failures = 0
let lastPollSeconds = 0

export function resetBusinessMetricsForTest(): void {
  last = null
  failures = 0
  lastPollSeconds = 0
}

/** Pure: the snapshot for these rows. */
export function deriveSubscriptionMetrics(rows: readonly SubscriptionRow[]): Snapshot {
  const subscriptions = new Map<string, number>()
  const paid = new Map<string, number>()
  const licences = new Map<string, number>()
  const currencies: string[] = [DEFAULT_CURRENCY]
  const currencyOf = (c: unknown): string => {
    const u = typeof c === 'string' && /^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : 'OTHER'
    if (currencies.includes(u)) return u
    if (u === 'OTHER' || currencies.length >= MAX_CURRENCIES) {
      if (!currencies.includes('OTHER')) currencies.push('OTHER')
      return 'OTHER'
    }
    currencies.push(u)
    return u
  }
  for (const r of rows) {
    const tier = closed(BM_TIERS, r.tier)
    const term = closed(BM_TERMS, r.term)
    const grant = closed(BM_GRANT_KINDS, r.grantKind)
    const status = closed(BM_STATUSES, r.status)
    const k = key(tier, term, grant, status)
    subscriptions.set(k, (subscriptions.get(k) ?? 0) + 1)
    const cur = currencyOf(r.paidCurrency)
    const minor = Number(r.paidAmountMinor)
    if (Number.isFinite(minor) && minor > 0) {
      const major = cur === 'OTHER' ? minor / 100 : minor / 10 ** currencyDecimals(cur)
      const pk = key(cur, tier, term, status)
      paid.set(pk, (paid.get(pk) ?? 0) + major)
    }
    for (const l of Array.isArray(r.licences) ? r.licences : []) {
      const s = closed(BM_LICENCE_STATES, l?.state)
      licences.set(s, (licences.get(s) ?? 0) + 1)
    }
  }
  return { subscriptions, paid, licences, currencies }
}

/** Round to the currency's precision so a sum of floats prints as 12.5, not 12.499999999. */
const tidy = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * Render the business-metric families. `read` is the ledger read; a throw keeps the last snapshot
 * and counts a failure. Never throws.
 */
export async function renderSubscriptionBusinessMetrics(read: () => Promise<readonly SubscriptionRow[]>, nowSeconds: number): Promise<string> {
  try {
    last = deriveSubscriptionMetrics(await read())
    lastPollSeconds = nowSeconds
  } catch {
    failures += 1
  }
  const snap = last ?? deriveSubscriptionMetrics([])
  const lines: string[] = []
  const head = (name: string, type: string, help: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)

  head('imani_subscriptions', 'gauge', 'Subscription records in the ledger, by tier, term, grant kind and status (cancelled = will not renew, still paid for).')
  for (const t of BM_TIERS)
    for (const m of BM_TERMS)
      for (const g of BM_GRANT_KINDS)
        for (const s of BM_STATUSES)
          lines.push(`imani_subscriptions{tier="${t}",term="${m}",grant_kind="${g}",status="${s}"} ${snap.subscriptions.get(key(t, m, g, s)) ?? 0}`)

  head('imani_subscription_paid_value', 'gauge', 'Sum of the latest paid invoice per subscription, major units of currency. Not lifetime revenue.')
  for (const c of snap.currencies)
    for (const t of BM_TIERS)
      for (const m of BM_TERMS)
        for (const s of BM_STATUSES)
          lines.push(`imani_subscription_paid_value{currency="${esc(c)}",tier="${t}",term="${m}",status="${s}"} ${tidy(snap.paid.get(key(c, t, m, s)) ?? 0)}`)

  head('imani_subscription_licences', 'gauge', 'Licences in the ledger by delivery state.')
  for (const s of BM_LICENCE_STATES) lines.push(`imani_subscription_licences{state="${s}"} ${snap.licences.get(s) ?? 0}`)

  head('imani_business_metrics_poll_failures_total', 'counter', 'Business-metrics polls that failed; the last values are kept.')
  lines.push(`imani_business_metrics_poll_failures_total{source="${BM_SOURCE}"} ${failures}`)
  head('imani_business_metrics_last_poll_seconds', 'gauge', 'Unix time of the last successful business-metrics poll.')
  lines.push(`imani_business_metrics_last_poll_seconds{source="${BM_SOURCE}"} ${lastPollSeconds}`)
  return lines.join('\n') + '\n'
}
