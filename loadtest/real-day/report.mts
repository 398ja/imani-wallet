/**
 * Results and the generated Markdown report of a real day (#550). Pure: the runner records
 * attempts; this aggregates, gates and renders. Every string is redacted on the way out.
 */
import type { Conservation } from './ledger.mts'
import { redact, redactDeep } from './redact.mts'
import type { Journey } from './schedule.mts'

/**
 * `rate-limited`: a 429 from a limiter that should have been lifted for this IP (an app/deploy
 * finding). `pacing`: a 429 from a limiter that is NOT lifted (imani-deploy#405) and that the
 * harness was meant to pace under: a harness failure, never counted against the app.
 */
export type Outcome = 'ok' | 'fail' | 'skip' | 'rate-limited' | 'pacing'

export type Attempt = {
  journey: Journey
  persona: string
  outcome: Outcome
  startedAt: number
  endedAt: number
  /** Action to user-visible outcome, for ok attempts. */
  visibleMs?: number
  /** What the user saw: "coupon visible in wallet", "Paid shown on both sides". */
  observed?: string
  /** Skip reason, or the failure's screen text (redacted when recorded). */
  detail?: string
}

export type Population = {
  customers: number
  browserCustomers: number
  k6Customers: number
  stalls: number
  stallNames: string[]
  mode: 'full' | 'smoke' | 'dry-run'
  day: string
  seed: number
  base: string
}

export const THRESHOLDS = {
  successRate: 0.95,
  p95Ms: { buy: 20_000, pay: 20_000, send: 30_000 } as Partial<Record<Journey, number>>,
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

export type JourneyStats = {
  journey: Journey
  attempts: number
  ok: number
  fail: number
  skip: number
  rateLimited: number
  pacing: number
  successRate: number | null
  p50: number | null
  p95: number | null
  p99: number | null
  skipReasons: string[]
  failures: { persona: string; detail: string }[]
}

export function journeyStats(attempts: Attempt[]): JourneyStats[] {
  const by = new Map<Journey, Attempt[]>()
  for (const a of attempts) by.set(a.journey, [...(by.get(a.journey) ?? []), a])
  return [...by.entries()].map(([journey, list]) => {
    const ok = list.filter((a) => a.outcome === 'ok')
    const fail = list.filter((a) => a.outcome === 'fail')
    const limited = list.filter((a) => a.outcome === 'rate-limited')
    const skip = list.filter((a) => a.outcome === 'skip')
    const pacing = list.filter((a) => a.outcome === 'pacing')
    // Rate-limited attempts count against success: they are what the user saw. They are
    // reported apart so a run that measured the limiter says so.
    const judged = ok.length + fail.length + limited.length
    const ms = ok.map((a) => a.visibleMs).filter((v): v is number => typeof v === 'number')
    return {
      journey,
      attempts: list.length,
      ok: ok.length,
      fail: fail.length,
      skip: skip.length,
      rateLimited: limited.length,
      pacing: pacing.length,
      successRate: judged ? ok.length / judged : null,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      p99: percentile(ms, 99),
      skipReasons: [...new Set(skip.map((a) => redact(a.detail ?? 'no reason given')))],
      failures: [...fail, ...limited, ...pacing].map((a) => ({
        persona: a.persona,
        detail: redact(`${a.outcome === 'rate-limited' ? '[429] ' : a.outcome === 'pacing' ? '[429 HARNESS PACING] ' : ''}${a.detail ?? ''}`).slice(0, 600),
      })),
    }
  })
}

export type Gate = { name: string; ok: boolean; detail: string }

export function gates(
  stats: JourneyStats[],
  extra: { pageErrors: string[]; unsavedReceives: string[]; conservation: Conservation | null; k6: K6Summary | null },
): Gate[] {
  const out: Gate[] = []
  for (const s of stats) {
    if (s.successRate === null) continue
    out.push({
      name: `${s.journey} success >= ${THRESHOLDS.successRate * 100}%`,
      ok: s.successRate >= THRESHOLDS.successRate,
      detail: `${s.ok}/${s.ok + s.fail + s.rateLimited}${s.rateLimited ? ` (${s.rateLimited} rate-limited)` : ''}`,
    })
    const bound = THRESHOLDS.p95Ms[s.journey]
    if (bound !== undefined && s.p95 !== null) {
      out.push({ name: `${s.journey} p95 < ${bound / 1000}s`, ok: s.p95 < bound, detail: `p95 ${(s.p95 / 1000).toFixed(1)}s` })
    }
  }
  const paced = stats.reduce((n, s) => n + s.pacing, 0)
  out.push({ name: 'harness paced under the un-lifted limits (no 429 there)', ok: paced === 0, detail: paced ? `${paced} attempts hit an un-lifted limiter: a harness pacing failure, not an app failure` : 'none' })
  out.push({ name: 'no uncaught page errors', ok: extra.pageErrors.length === 0, detail: extra.pageErrors.slice(0, 5).map(redact).join(' || ') || 'none' })
  out.push({ name: 'no settled-but-not-saved', ok: extra.unsavedReceives.length === 0, detail: extra.unsavedReceives.slice(0, 5).map(redact).join(' || ') || 'none' })
  if (extra.conservation) {
    const c = extra.conservation
    out.push({
      name: 'money is conserved',
      ok: c.ok,
      detail: c.ok ? 'every persona matched' : [
        ...c.mismatches.map((m) => `${redact(m.persona)} ${m.unit} observed ${m.observed} expected ${m.expected}`),
        ...c.unread.map((p) => `${redact(p)} unread`),
      ].join('; '),
    })
  }
  if (extra.k6) {
    out.push({ name: 'k6 sale_delivered > 95%', ok: extra.k6.saleDelivered === null || extra.k6.saleDelivered > 0.95, detail: fmtRate(extra.k6.saleDelivered) })
    out.push({ name: 'k6 voucher-poll failures < 5%', ok: extra.k6.voucherPollFailed === null || extra.k6.voucherPollFailed < 0.05, detail: fmtRate(extra.k6.voucherPollFailed) })
    out.push({ name: 'k6 thresholds held', ok: extra.k6.thresholdsCrossed.length === 0, detail: extra.k6.thresholdsCrossed.join(', ') || 'all held' })
  }
  return out
}

const fmtRate = (r: number | null) => (r === null ? 'not measured' : `${(r * 100).toFixed(1)}%`)
const fmtMs = (v: number | null) => (v === null ? '-' : `${(v / 1000).toFixed(1)}s`)

export type K6Summary = {
  exitCode: number | null
  saleDelivered: number | null
  voucherPollFailed: number | null
  thresholdsCrossed: string[]
  counters: Record<string, number>
  note?: string
}

/** Reads what market-day.js wrote (k6's summary JSON). */
export function summariseK6(data: unknown, exitCode: number | null): K6Summary {
  const metrics = ((data as { metrics?: Record<string, { values?: Record<string, number>; thresholds?: Record<string, { ok: boolean }> }> })?.metrics) ?? {}
  const rate = (name: string) => (metrics[name]?.values?.rate ?? null)
  const counters: Record<string, number> = {}
  for (const [name, m] of Object.entries(metrics)) if (typeof m.values?.count === 'number' && !name.includes('{')) counters[name] = m.values.count
  return {
    exitCode,
    saleDelivered: rate('sale_delivered'),
    voucherPollFailed: rate('http_req_failed{name:read coupon}'),
    thresholdsCrossed: Object.entries(metrics).filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok)).map(([n]) => n),
    counters,
  }
}

/** One line per minute: journeys started, completed, failed. */
export function timeline(attempts: Attempt[], start: number): { minute: number; started: number; completed: number; failed: number }[] {
  if (attempts.length === 0) return []
  const last = Math.max(...attempts.map((a) => a.endedAt))
  const minutes = Math.floor((last - start) / 60_000) + 1
  const rows = Array.from({ length: minutes }, (_, minute) => ({ minute, started: 0, completed: 0, failed: 0 }))
  for (const a of attempts) {
    const s = Math.max(0, Math.floor((a.startedAt - start) / 60_000))
    const e = Math.max(0, Math.floor((a.endedAt - start) / 60_000))
    if (rows[s]) rows[s].started++
    if (rows[e]) {
      if (a.outcome === 'ok') rows[e].completed++
      if (a.outcome === 'fail' || a.outcome === 'rate-limited') rows[e].failed++
    }
  }
  return rows
}

export type RunResult = {
  population: Population
  startedAt: string
  durationS: number
  stats: JourneyStats[]
  gates: Gate[]
  pass: boolean
  timeline: ReturnType<typeof timeline>
  conservation: Conservation | null
  k6: K6Summary | null
  rateLimitProbe: string
  /** The limits that stay on during the run and how the harness paces under them. */
  limits: string[]
  notes: string[]
  attempts: Attempt[]
}

export function buildResult(input: Omit<RunResult, 'stats' | 'gates' | 'pass' | 'timeline'> & { pageErrors: string[]; unsavedReceives: string[]; startMs: number }): RunResult {
  const stats = journeyStats(input.attempts)
  const g = gates(stats, input)
  const { pageErrors: _p, unsavedReceives: _u, startMs, ...rest } = input
  void _p
  void _u
  return redactDeep({ ...rest, stats, gates: g, pass: g.every((x) => x.ok), timeline: timeline(input.attempts, startMs) })
}

export function resultName(date: Date, population: Population): string {
  const size = population.mode === 'smoke' ? `smoke-${population.stalls}s${population.browserCustomers}c` : `${population.customers}c${population.stalls}s`
  return `${date.toISOString().slice(0, 10)}-real-day-${size}`
}

export function renderMarkdown(r: RunResult): string {
  const p = r.population
  const lines: string[] = [
    `# Real market day: ${p.mode}, ${r.pass ? 'PASS' : 'FAIL'}`,
    '',
    `- **Population:** ${p.customers} customers + ${p.stalls} stalls (${p.stallNames.join(', ')})`,
    `- **Split:** ${p.browserCustomers} customers and ${p.stalls} stalls in the real app (Playwright), ${p.k6Customers} customers in the k6 crowd (market-day.js)`,
    `- **Target:** ${p.base}, day ${p.day}, SEED=${p.seed}`,
    `- **Started:** ${r.startedAt}, ran ${Math.round(r.durationS)}s`,
    `- **Rate-limit probe:** ${r.rateLimitProbe}`,
    `- **Limits still on (paced by the harness):**`,
    ...r.limits.map((l) => `  - ${l}`),
    '',
    '## Journeys',
    '',
    '| journey | attempts | ok | fail | 429 app | 429 pacing | skip | success | p50 | p95 | p99 |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...r.stats.map((s) => `| ${s.journey} | ${s.attempts} | ${s.ok} | ${s.fail} | ${s.rateLimited} | ${s.pacing} | ${s.skip} | ${s.successRate === null ? '-' : `${(s.successRate * 100).toFixed(0)}%`} | ${fmtMs(s.p50)} | ${fmtMs(s.p95)} | ${fmtMs(s.p99)} |`),
    '',
  ]
  const skips = r.stats.filter((s) => s.skipReasons.length)
  if (skips.length) {
    lines.push('### SKIPs', '', ...skips.flatMap((s) => s.skipReasons.map((why) => `- **${s.journey}**: ${why}`)), '')
  }
  const fails = r.stats.filter((s) => s.failures.length)
  if (fails.length) {
    lines.push('### Failures (screen text, persona)', '')
    for (const s of fails) for (const f of s.failures.slice(0, 10)) lines.push(`- **${s.journey}** ${f.persona}: \`${f.detail.replace(/`/g, "'").replace(/\n/g, ' | ')}\``)
    lines.push('')
  }
  lines.push('## Gates', '', ...r.gates.map((g) => `- ${g.ok ? 'PASS' : 'FAIL'} ${g.name}: ${g.detail}`), '')
  if (r.conservation) {
    lines.push('## Money', '')
    for (const [unit, t] of Object.entries(r.conservation.totals)) {
      lines.push(`- ${unit}: observed change ${t.observed}, expected ${t.expected} (issued ${t.issued}, burnt ${t.burnt}, links outstanding ${t.outstandingLinks}) minor units`)
    }
    lines.push('')
  }
  lines.push('## k6 crowd', '')
  if (r.k6) {
    lines.push(`- exit ${r.k6.exitCode ?? '-'}; sale_delivered ${fmtRate(r.k6.saleDelivered)}; voucher-poll failed ${fmtRate(r.k6.voucherPollFailed)}`)
    if (r.k6.note) lines.push(`- ${r.k6.note}`)
    for (const [k, v] of Object.entries(r.k6.counters).sort()) lines.push(`- ${k}: ${v}`)
  } else lines.push('- not run')
  lines.push('', '## Timeline (per minute)', '', '| min | started | completed | failed |', '|---|---|---|---|')
  lines.push(...r.timeline.map((t) => `| ${t.minute} | ${t.started} | ${t.completed} | ${t.failed} |`))
  if (r.notes.length) lines.push('', '## Notes', '', ...r.notes.map((n) => `- ${n}`))
  lines.push('')
  return redact(lines.join('\n'))
}
