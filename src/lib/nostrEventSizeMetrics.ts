/**
 * Nostr event size metrics for the Node services (imani-wallet#532), dependency free.
 *
 * Lives in src/lib because each service image copies individual wallet files from there; it has no
 * imports, so copying this one file is the whole dependency (serviceImageCopies.test.ts).
 *
 * Contract (shared with gateway-customer and the dashboard; keep names, buckets and kinds in step):
 * - imani_nostr_event_bytes (histogram), labels source, kind, path
 * - imani_nostr_event_over_limit_total (counter), labels source, kind, path, limit
 * - imani_nostr_event_limit_bytes (gauge), label limit
 * Labels are closed sets. Never an id, pubkey or relay URL.
 */

export const SOURCES = ['gateway-customer', 'gateway-core', 'wallet', 'subscription', 'audit-api', 'purchase-issuer'] as const
export type Source = (typeof SOURCES)[number]
export const PATHS = ['relay', 'event_store'] as const
export type EventPath = (typeof PATHS)[number]

export const KINDS: readonly number[] = [
  0, 1, 3, 4, 5, 7, 13, 14, 1059, 7375, 7376, 10002, 10019, 17375, 22242, 24133, 27235, 30078, 30402, 31990, 38172, 38173,
  9734, 9735,
]
const KIND_SET = new Set(KINDS)

/** The decimal kind if it is in the closed set, else "other". */
export function kindLabel(kind: number): string {
  return Number.isInteger(kind) && KIND_SET.has(kind) ? String(kind) : 'other'
}

/** Upper bounds (le), in bytes, without +Inf. */
export const BUCKETS: readonly number[] = (() => {
  const b = [1024, 2048]
  for (let v = 4096; v <= 131072; v += 4096) b.push(v)
  b.push(55121, 196608, 262144, 524288, 1048576)
  return b.sort((x, y) => x - y)
})()

export const DEFAULT_LIMITS_SPEC = 'strfry_max_event=65536,wrap_budget=55121'
export interface Limit {
  name: string
  bytes: number
}

/** Strict parse of `name=bytes,...`. Throws on anything the contract does not allow. */
export function parseLimitsStrict(spec: string): Limit[] {
  const parts = spec.split(',').map((p) => p.trim()).filter((p) => p.length > 0)
  if (parts.length === 0) throw new Error('no limits')
  if (parts.length > 8) throw new Error('at most 8 limits')
  const seen = new Set<string>()
  return parts.map((p) => {
    const m = /^([a-z0-9_]{1,32})=([0-9]+)$/.exec(p)
    if (!m) throw new Error(`invalid limit "${p}"`)
    const bytes = Number(m[2])
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`invalid bytes in "${p}"`)
    if (seen.has(m[1])) throw new Error(`duplicate limit "${m[1]}"`)
    seen.add(m[1])
    return { name: m[1], bytes }
  })
}

/** NOSTR_EVENT_SIZE_LIMITS, or the default. Invalid config is logged and the default used. */
export function parseLimits(spec: string | undefined, log: (msg: string) => void = console.error): Limit[] {
  if (spec === undefined || spec.trim() === '') return parseLimitsStrict(DEFAULT_LIMITS_SPEC)
  try {
    return parseLimitsStrict(spec)
  } catch (e) {
    log(`[event-size] NOSTR_EVENT_SIZE_LIMITS invalid (${(e as Error).message}); using default ${DEFAULT_LIMITS_SPEC}`)
    return parseLimitsStrict(DEFAULT_LIMITS_SPEC)
  }
}

interface Series {
  buckets: number[]
  count: number
  sum: number
}

export interface EventSizeRecorder {
  /** Measure the event JSON as sent and record it. Returns the bytes. Never throws. */
  recordEvent(event: unknown, path?: EventPath): number
  record(kind: number, bytes: number, path?: EventPath): void
  render(): string
  readonly limits: readonly Limit[]
}

export function eventJsonBytes(event: unknown): number {
  return new TextEncoder().encode(JSON.stringify(event)).length
}

export function createEventSizeRecorder(source: Source, limits: readonly Limit[] = parseLimits(process.env.NOSTR_EVENT_SIZE_LIMITS)): EventSizeRecorder {
  const hist = new Map<string, Series>()
  const over = new Map<string, number>()
  const key = (kind: string, path: string) => `${kind}\u0000${path}`

  const record = (kind: number, bytes: number, path: EventPath = 'relay') => {
    const k = kindLabel(kind)
    let s = hist.get(key(k, path))
    if (!s) hist.set(key(k, path), (s = { buckets: BUCKETS.map(() => 0), count: 0, sum: 0 }))
    BUCKETS.forEach((le, i) => {
      if (bytes <= le) s.buckets[i]++
    })
    s.count++
    s.sum += bytes
    for (const l of limits) {
      if (bytes > l.bytes) {
        const ok = `${k}\u0000${path}\u0000${l.name}`
        over.set(ok, (over.get(ok) ?? 0) + 1)
      }
    }
  }

  return {
    limits,
    record,
    recordEvent(event, path = 'relay') {
      try {
        const bytes = eventJsonBytes(event)
        const kind = (event as { kind?: unknown } | null)?.kind
        record(typeof kind === 'number' ? kind : -1, bytes, path)
        return bytes
      } catch {
        return 0
      }
    },
    render() {
      const out: string[] = []
      const src = `source="${source}"`
      out.push('# HELP imani_nostr_event_bytes Size of each Nostr event as sent, in bytes (UTF-8 JSON).')
      out.push('# TYPE imani_nostr_event_bytes histogram')
      for (const [k, s] of [...hist].sort(([a], [b]) => a.localeCompare(b))) {
        const [kind, path] = k.split('\u0000')
        const base = `${src},kind="${kind}",path="${path}"`
        BUCKETS.forEach((le, i) => out.push(`imani_nostr_event_bytes_bucket{${base},le="${le}"} ${s.buckets[i]}`))
        out.push(`imani_nostr_event_bytes_bucket{${base},le="+Inf"} ${s.count}`)
        out.push(`imani_nostr_event_bytes_sum{${base}} ${s.sum}`)
        out.push(`imani_nostr_event_bytes_count{${base}} ${s.count}`)
      }
      out.push('# HELP imani_nostr_event_over_limit_total Events strictly larger than a configured limit.')
      out.push('# TYPE imani_nostr_event_over_limit_total counter')
      for (const [k, n] of [...over].sort(([a], [b]) => a.localeCompare(b))) {
        const [kind, path, limit] = k.split('\u0000')
        out.push(`imani_nostr_event_over_limit_total{${src},kind="${kind}",path="${path}",limit="${limit}"} ${n}`)
      }
      out.push('# HELP imani_nostr_event_limit_bytes Configured event size limit, in bytes.')
      out.push('# TYPE imani_nostr_event_limit_bytes gauge')
      for (const l of limits) out.push(`imani_nostr_event_limit_bytes{limit="${l.name}"} ${l.bytes}`)
      return out.join('\n') + '\n'
    },
  }
}
