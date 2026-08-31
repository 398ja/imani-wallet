import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { renderMetrics } from '../metrics'

/**
 * The dashboard and the exposition text are ONE contract, asserted here.
 *
 * `imani-deploy/docs/how-to/add-a-metric.md` exists because an audit found ~100
 * declared metrics that reached no dashboard, every one with a green test suite.
 * Its finding was that the proxies people assert on — the meter API, a registry
 * lookup, the alert expression's shape — all pass while the panel reads "No
 * data". The only thing that cannot lie is the scrape text.
 *
 * So this test parses the real dashboard JSON out of the deploy repo, extracts
 * every metric name its panels query, and requires each to appear in what
 * `renderMetrics` actually emits. Renaming a metric now fails the wallet's suite
 * instead of silently emptying a panel that nobody looks at until an incident.
 *
 * The dashboard lives in another repo with nothing connecting the two — exactly
 * the gap that let the prod CSP `frame-src` miss ship twice (DEV-249). This is
 * the thread between them.
 */

const DASHBOARD = resolve(
  import.meta.dirname,
  '../../../../imani-deploy/observability/grafana/dashboards/redemption-audit-ledger.json',
)

interface Panel {
  title?: string
  type?: string
  collapsed?: boolean
  panels?: unknown[]
  targets?: { expr: string }[]
}

function dashboard(): { panels: Panel[] } | undefined {
  try {
    return JSON.parse(readFileSync(DASHBOARD, 'utf8')) as { panels: Panel[] }
  } catch {
    // The deploy repo is a sibling checkout, not a dependency. Absent is not a
    // failure — but it must SKIP loudly rather than pass silently, or this test
    // becomes a green tick that checks nothing on any machine without it.
    return undefined
  }
}

/** Metric names a PromQL expression reads, ignoring functions and labels. */
function metricsIn(expr: string): string[] {
  return [...expr.matchAll(/\b(audit_[a-z0-9_]*)/g)].map((m) => m[1])
}

describe('the Grafana dashboard queries metrics this service actually emits', () => {
  const dash = dashboard()

  it.runIf(dash)('every panel resolves against real exposition text', () => {
    // Rendered WITH a snapshot, because the ledger gauges are only emitted once
    // the stream has been read at least once — a check against an empty render
    // would report the four most important panels as broken.
    const exposition = renderMetrics({
      accepted: [
        {
          nullifier: 'n',
          commitment: 'c',
          unit: 'XAF',
          ledgerPubkey: 'k',
          eventId: 'e',
          at: Date.now(),
        },
      ],
      rejected: [{ eventId: 'e2', defect: 'bad_signature' }],
      fetchedAt: Date.now(),
    })

    const emitted = new Set(
      exposition
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('{')[0].split(' ')[0]),
    )

    const broken: string[] = []
    for (const panel of dash!.panels) {
      for (const target of panel.targets ?? []) {
        for (const metric of metricsIn(target.expr)) {
          if (!emitted.has(metric)) broken.push(`${panel.title}: ${metric}`)
        }
      }
    }

    expect(broken).toEqual([])
  })

  it.runIf(dash)('the alerting series exist before the incident that would create them', () => {
    // The rule this whole file is written against: a series that springs into
    // existence on first use is ABSENT on a quiet service, absent looks like
    // zero on a graph, and a ratio over it evaluates to nothing — so the alert
    // cannot fire on a service that has never answered a check.
    const exposition = renderMetrics()
    expect(exposition).toContain('audit_api_coupon_checks_total{verdict="missing"} 0')
    expect(exposition).toContain('audit_api_coupon_checks_total{verdict="conflicting"} 0')
  })

  it.runIf(dash)('every row panel carries the fields Grafana needs to render it', () => {
    // A row without `collapsed` and `panels` is not a row Grafana can lay out.
    // Loading the dashboard in real Grafana rendered an entirely EMPTY page —
    // not "No data" in each panel, nothing at all, while every query returned
    // data perfectly through the API. Nothing short of a browser catches that:
    // the JSON is valid, the queries resolve, and the metric-name check above
    // passes throughout.
    const rows = dash!.panels.filter((p) => p.type === 'row')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row, `row "${row.title}" needs collapsed`).toHaveProperty('collapsed')
      expect(row, `row "${row.title}" needs panels`).toHaveProperty('panels')
    }
  })

  it.runIf(dash)('panel titles are short enough not to truncate in a stat panel', () => {
    // "Redemptions on the public ledger" rendered as "Redemptions on the …" in
    // a quarter-width stat panel. The number is the point of those panels, and
    // a clipped title makes the reader guess which number they are looking at.
    // The description (the ⓘ) is where the long explanation belongs.
    const stats = dash!.panels.filter((p) => p.type === 'stat')
    for (const p of stats) {
      expect((p.title ?? '').length, `stat title too long: "${p.title}"`).toBeLessThanOrEqual(24)
    }
  })
})
