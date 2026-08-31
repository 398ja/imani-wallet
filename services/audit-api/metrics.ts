/**
 * Prometheus exposition for the audit API.
 *
 * Written against `imani-deploy/docs/how-to/add-a-metric.md`, which exists
 * because an audit there found ~100 declared metrics that reached no dashboard,
 * every one with a green test suite. Its rules are followed here deliberately:
 *
 * **Every series is registered before anything happens.** A counter that springs
 * into existence on first use is ABSENT on a quiet service, and absent renders
 * on a dashboard exactly like zero while making any ratio over it evaluate to
 * nothing — so the alert cannot fire on a service that has never served a
 * request, which is precisely when the first error matters most. Hence the
 * zero-initialised fields below and the full `couponChecks` domain: `missing`
 * and `conflicting` are the values an operator will search for during an
 * incident, and that incident must not be what creates them.
 *
 * **The dashboard reads THIS text.** Panels query the names emitted here, so
 * these strings and the dashboard JSON are one contract; the test asserts against
 * rendered exposition rather than the object, for the same reason that document
 * gives.
 */
import type { AuditedAttestation, RejectedAttestation } from '../../src/lib/audit'

export interface Metrics {
  requests: number
  requestSeconds: number
  errors: number
  relayQueries: number
  relayQuerySeconds: number
  relayErrors: number
  cacheHits: number
  cacheMisses: number
  /** 1 when the last relay fetch succeeded. The liveness signal that matters. */
  lastFetchOk: number
  /** Closed domain, all four pre-registered. */
  couponChecks: Record<string, number>
}

export const metrics: Metrics = {
  requests: 0,
  requestSeconds: 0,
  errors: 0,
  relayQueries: 0,
  relayQuerySeconds: 0,
  relayErrors: 0,
  cacheHits: 0,
  cacheMisses: 0,
  lastFetchOk: 0,
  couponChecks: { honoured: 0, missing: 0, pending: 0, conflicting: 0 },
}

/** Reset between tests. Not called in production. */
export function resetMetrics(): void {
  Object.assign(metrics, {
    requests: 0,
    requestSeconds: 0,
    errors: 0,
    relayQueries: 0,
    relayQuerySeconds: 0,
    relayErrors: 0,
    cacheHits: 0,
    cacheMisses: 0,
    lastFetchOk: 0,
    couponChecks: { honoured: 0, missing: 0, pending: 0, conflicting: 0 },
  })
}

interface Snapshot {
  accepted: AuditedAttestation[]
  rejected: RejectedAttestation[]
  fetchedAt: number
}

/**
 * Render exposition text.
 *
 * The stream gauges are computed from the cached snapshot rather than
 * accumulated, because they describe the WORLD (how many redemptions exist),
 * not this process's activity. A counter would reset on restart and double-count
 * across replicas; a gauge read from the snapshot is correct in both cases.
 */
export function renderMetrics(snapshot?: Snapshot): string {
  const lines: string[] = []
  const emit = (name: string, type: string, help: string, samples: [string, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`)
  }

  emit('audit_api_requests_total', 'counter', 'HTTP requests served.', [['', metrics.requests]])
  emit('audit_api_request_duration_seconds_total', 'counter', 'Cumulative request time.', [
    ['', Number(metrics.requestSeconds.toFixed(3))],
  ])
  emit('audit_api_errors_total', 'counter', 'Requests that failed outright.', [
    ['', metrics.errors],
  ])
  emit('audit_api_relay_queries_total', 'counter', 'Queries issued to the relay.', [
    ['', metrics.relayQueries],
  ])
  emit(
    'audit_api_relay_query_duration_seconds_total',
    'counter',
    'Cumulative relay query time.',
    [['', Number(metrics.relayQuerySeconds.toFixed(3))]],
  )
  emit('audit_api_relay_errors_total', 'counter', 'Relay queries that failed.', [
    ['', metrics.relayErrors],
  ])
  emit('audit_api_relay_up', 'gauge', 'Whether the last relay fetch succeeded.', [
    ['', metrics.lastFetchOk],
  ])
  emit('audit_api_cache_hits_total', 'counter', 'Snapshot reads served from cache.', [
    ['', metrics.cacheHits],
  ])
  emit('audit_api_cache_misses_total', 'counter', 'Snapshot reads that hit the relay.', [
    ['', metrics.cacheMisses],
  ])

  // Closed label domain, every value emitted even at zero. `missing` and
  // `conflicting` are the ones an operator alerts on, and a series that appears
  // only once the bad thing happens cannot be alerted on beforehand.
  emit(
    'audit_api_coupon_checks_total',
    'counter',
    'Coupon checks answered, by verdict.',
    Object.entries(metrics.couponChecks).map(([verdict, n]) => [`{verdict="${verdict}"}`, n]),
  )

  // The ledger itself. Absent until the first successful fetch — deliberately,
  // because emitting 0 redemptions before we have ever read the relay would
  // assert something false about the world rather than about this process.
  if (snapshot) {
    emit('audit_ledger_redemptions', 'gauge', 'Attestations that audit cleanly.', [
      ['', snapshot.accepted.length],
    ])
    emit('audit_ledger_refused', 'gauge', 'Events this reader will not read.', [
      ['', snapshot.rejected.length],
    ])
    emit(
      'audit_ledger_merchants',
      'gauge',
      'Distinct ledger keys publishing.',
      [['', new Set(snapshot.accepted.map((a) => a.ledgerPubkey)).size]],
    )
    emit(
      'audit_ledger_snapshot_age_seconds',
      'gauge',
      'Age of the cached stream snapshot.',
      [['', Number(((Date.now() - snapshot.fetchedAt) / 1000).toFixed(3))]],
    )

    // Per-defect, so a dashboard can tell "somebody is publishing junk" from
    // "a publisher is ahead of this reader" — the second is a scheduled upgrade,
    // the first may be an attack, and one number cannot distinguish them.
    const byDefect = snapshot.rejected.reduce<Record<string, number>>((acc, r) => {
      acc[r.defect] = (acc[r.defect] ?? 0) + 1
      return acc
    }, {})
    // Full domain, so every defect series exists before the first bad event.
    for (const defect of [
      'wrong_kind',
      'bad_signature',
      'missing_nullifier',
      'unparseable_content',
      'nullifier_mismatch',
      'bad_commitment',
      'unknown_version',
    ]) {
      byDefect[defect] ??= 0
    }
    emit(
      'audit_ledger_refused_by_defect',
      'gauge',
      'Refused events by reason.',
      Object.entries(byDefect).map(([defect, n]) => [`{defect="${defect}"}`, n]),
    )
  }

  return `${lines.join('\n')}\n`
}
