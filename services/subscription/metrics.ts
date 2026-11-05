/**
 * Prometheus exposition for the subscription service (#407): subscriptions created and cancelled,
 * by plan tier.
 *
 * Written to `imani-deploy/docs/how-to/add-a-metric.md`:
 *  - every series exists before anything happens (closed label domains, pre-registered at zero),
 *    so a quiet service shows a zero rather than an absent series that hides an alert;
 *  - the tests assert the RENDERED TEXT, which is what Grafana and the alert rules read;
 *  - labels are closed sets: tier, term, status, event, day offset. Never a stall key, a
 *    subscription id or an amount.
 *
 * Two kinds of series, because they answer different questions:
 *
 *  1. Counters (`imani_subscription_events_total`): what THIS process saw, live. Grafana takes
 *     `increase()` over them. They reset on restart (Prometheus handles that) and keep only as long
 *     as Prometheus retains data, which on staging is 15 days.
 *  2. Ledger gauges (`imani_subscriptions`, `imani_subscription_events_by_day`): recomputed from the
 *     ledger on every scrape, so they describe the WORLD, not this process. They survive restarts,
 *     agree across replicas, and give a full 30-day daily history on the very first scrape. The
 *     30-day charts read these, which is why they do not depend on Prometheus' retention.
 */
import type { SubscriptionRow } from './ledger.ts'
import { createEventSizeRecorder } from '../../src/lib/nostrEventSizeMetrics.ts'

/** Nostr event sizes this service publishes to the relay (#532); limits from NOSTR_EVENT_SIZE_LIMITS. */
export const eventSizes = createEventSizeRecorder('subscription')

/** Every tier a subscription can be on. `custom` is a hand grant; `other` catches anything new. */
export const TIERS = ['basic', 'pro', 'custom', 'other'] as const
export type TierLabel = (typeof TIERS)[number]
export const TERMS = ['monthly', 'annual', 'custom', 'other'] as const
export type TermLabel = (typeof TERMS)[number]
export const EVENTS = ['created', 'cancelled', 'reactivated'] as const
export type EventLabel = (typeof EVENTS)[number]
export const STATUSES = ['active', 'cancelled', 'revoked'] as const
export const MESSAGE_RESULTS = ['sent', 'failed'] as const
export type MessageResult = (typeof MESSAGE_RESULTS)[number]
/** Days of daily history the ledger gauges carry, ending today (UTC). */
export const HISTORY_DAYS = 30

const tierOf = (t: string): TierLabel => ((TIERS as readonly string[]).includes(t) ? (t as TierLabel) : 'other')
const termOf = (t: string): TermLabel => ((TERMS as readonly string[]).includes(t) ? (t as TermLabel) : 'other')
const key = (...parts: string[]) => parts.join('|')

const events = new Map<string, number>()
const messages = new Map<MessageResult, number>()

function zero(): void {
  for (const e of EVENTS) for (const t of TIERS) for (const m of TERMS) events.set(key(e, t, m), 0)
  for (const r of MESSAGE_RESULTS) messages.set(r, 0)
}
zero()

/** A subscription created, cancelled or reactivated, as this process saw it happen. */
export function countTransition(event: EventLabel, tier: string, term: string): void {
  const k = key(event, tierOf(tier), termOf(term))
  events.set(k, (events.get(k) ?? 0) + 1)
}

/** The "your subscription was cancelled / is active again" DM to the stall's wallet. */
export function countStatusMessage(result: MessageResult): void {
  messages.set(result, (messages.get(result) ?? 0) + 1)
}

export function resetMetricsForTest(): void {
  zero()
}

/** Midnight UTC, in Unix seconds, of the day `seconds` falls on. */
const dayStart = (seconds: number) => Math.floor(seconds / 86_400) * 86_400

/**
 * Render exposition text. `rows` is the ledger; `nowSeconds` places "today" (UTC days, as Stripe
 * and the dashboard both count them).
 */
export function renderMetrics(rows: readonly SubscriptionRow[], nowSeconds: number): string {
  const lines: string[] = []
  const emit = (name: string, type: string, help: string, samples: Array<[string, number]>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`)
  }

  emit(
    'imani_subscription_events_total',
    'counter',
    'Subscriptions created, cancelled or reactivated, as this process saw them (counted on the Stripe webhook).',
    EVENTS.flatMap((e) =>
      TIERS.flatMap((t) => TERMS.map((m): [string, number] => [`{event="${e}",tier="${t}",term="${m}"}`, events.get(key(e, t, m)) ?? 0])),
    ),
  )
  emit(
    'imani_subscription_status_messages_total',
    'counter',
    "Cancellation / reactivation messages to the stall's wallet, by result.",
    MESSAGE_RESULTS.map((r): [string, number] => [`{result="${r}"}`, messages.get(r) ?? 0]),
  )

  // ---- From the ledger: the world, recomputed on every scrape.
  const current = new Map<string, number>()
  for (const t of TIERS) for (const s of STATUSES) current.set(key(t, s), 0)
  const byDay = new Map<string, number>()
  const today = dayStart(nowSeconds)
  // The last 30 UTC days as ISO dates, oldest first: the chart's x-axis, sorted as text = by date.
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => new Date((today - (HISTORY_DAYS - 1 - i) * 86_400) * 1000).toISOString().slice(0, 10))
  const inWindow = new Set(days)
  for (const e of ['created', 'cancelled'] as const) for (const t of TIERS) for (const d of days) byDay.set(key(e, t, d), 0)

  const dayOf = (seconds: number | undefined): string | null => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
    const d = new Date(dayStart(seconds) * 1000).toISOString().slice(0, 10)
    return inWindow.has(d) ? d : null
  }
  for (const r of rows) {
    const t = tierOf(r.tier)
    const s = (STATUSES as readonly string[]).includes(r.status) ? r.status : 'active'
    current.set(key(t, s), (current.get(key(t, s)) ?? 0) + 1)
    const c = dayOf(r.createdAt)
    if (c !== null) byDay.set(key('created', t, c), (byDay.get(key('created', t, c)) ?? 0) + 1)
    if (r.status === 'cancelled') {
      const x = dayOf(r.cancelledAt)
      if (x !== null) byDay.set(key('cancelled', t, x), (byDay.get(key('cancelled', t, x)) ?? 0) + 1)
    }
  }

  emit(
    'imani_subscriptions',
    'gauge',
    'Subscriptions in the ledger now, by tier and status (cancelled = will not renew, still paid for).',
    TIERS.flatMap((t) => STATUSES.map((s): [string, number] => [`{tier="${t}",status="${s}"}`, current.get(key(t, s)) ?? 0])),
  )
  emit(
    'imani_subscription_events_by_day',
    'gauge',
    'Subscriptions created / cancelled per UTC day over the last 30 days, from the ledger (day = YYYY-MM-DD). Cancelled counts subscriptions still cancelled now.',
    (['created', 'cancelled'] as const).flatMap((e) =>
      TIERS.flatMap((t) => days.map((d): [string, number] => [`{event="${e}",tier="${t}",day="${d}"}`, byDay.get(key(e, t, d)) ?? 0])),
    ),
  )
  emit('imani_subscription_ledger_rows', 'gauge', 'Rows in the sales ledger. Zero with paying stalls means the ledger was lost.', [
    ['', rows.length],
  ])
  return lines.join('\n') + '\n' + eventSizes.render()
}
