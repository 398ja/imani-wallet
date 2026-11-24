/**
 * Spec 049 receipt telemetry (closed-set counts only, FR-048).
 *
 * Same shape as `eventSizeTelemetry.ts`: batched, NIP-98 signed with the local signer, never
 * throws into the caller, never delays it. Contract (gateway-customer):
 * `POST /api/v1/telemetry/receipts` with `{"events":[{"event","outcome"}]}`, 1..100 entries,
 * 204 on success, 400 rejects the WHOLE batch on any bad entry, 429 at 30/min per pubkey.
 *
 * So: every entry is checked against the closed vocabulary before it is queued (an unknown pair
 * is dropped, never sent), counts are aggregated in memory so a burst is one entry per pair, and
 * a 429 backs off (counts are kept, merged back, and sent after the back-off). A 400 or any other
 * failure drops the batch: never a retry storm.
 */

export const ENDPOINT = '/api/v1/telemetry/receipts'
export const FLUSH_INTERVAL_MS = 60_000
export const MAX_BATCH = 100
/** After a 429: the limit is per minute, so wait one out. */
export const BACKOFF_MS = 60_000
/** Most queued entries kept; beyond it the oldest are dropped. */
export const MAX_QUEUE = 1_000

const ACK_OUTCOMES = ['attached', 'duplicate', 'mismatch', 'unknown_payment', 'not_settled'] as const
const CHECK_STATES = ['found_in_records', 'not_in_records', 'confirmed_by_mint', 'not_valid'] as const

/** The closed vocabulary, event to allowed outcomes. Exactly the gateway's. */
export const VOCABULARY: Readonly<Record<string, readonly string[]>> = {
  payment: ['dleq', 'none', 'locked_dleq', 'locked_none'],
  payment_cancelled: ['ok'],
  built: ['countersigned', 'uncountersigned'],
  settle_deferred: ['ok'],
  pending_stale: ['ok'],
  acknowledgement: [...ACK_OUTCOMES.map((o) => `message_${o}`), ...ACK_OUTCOMES.map((o) => `scan_${o}`)],
  claim: ['acknowledged_delivered', 'acknowledged_undelivered', 'acknowledged_payer_unknown', 'not_acknowledged', 'nothing_mine', 'other'],
  shown: ['published', 'already_reachable', 'deferred', 'none', 'other'],
  check: [...CHECK_STATES.map((s) => `records_${s}`), ...CHECK_STATES.map((s) => `mint_${s}`)],
  verification: ['verified', 'verified_offline', 'verified_summary_only', 'unacknowledged', 'invalid'],
  refund: ['refunded', 'delivery_deferred', 'payment_failed', 'refused_over_remaining', 'refused_unknown_payment', 'refused_payer_unknown', 'refused_other'],
  refund_received: ['accepted', 'rejected'],
  backup: ['saved', 'deferred'],
  restore: ['ok'],
  restore_receipt: ['added', 'merged'],
  restore_unreadable: ['ok'],
}

export interface ReceiptTelemetryEntry {
  event: string
  outcome: string
}

export function isKnown(event: string, outcome: string): boolean {
  return Object.prototype.hasOwnProperty.call(VOCABULARY, event) && VOCABULARY[event].includes(outcome)
}

/** Resolves 'ok', 'rate_limited' or 'rejected'. May throw; the caller swallows it. */
export type ReceiptBatchSender = (events: ReceiptTelemetryEntry[]) => Promise<'ok' | 'rate_limited' | 'rejected'>

export const defaultSender: ReceiptBatchSender = async (events) => {
  const { getSigner } = await import('../nap')
  let signer
  try {
    signer = getSigner()
  } catch {
    return 'rejected'
  }
  if (typeof signer.hasKey === 'function' && !signer.hasKey()) return 'rejected'
  const { signedFetch } = await import('../nip98')
  const response = await signedFetch(ENDPOINT, 'POST', { events }, signer, { keepalive: true })
  if (response.status === 429) return 'rate_limited'
  return response.ok ? 'ok' : 'rejected'
}

export interface ReceiptTelemetry {
  count(event: string, outcome: string): void
  flush(): Promise<void>
  /** Test seam: aggregated pairs waiting. */
  pending(): number
  stop(): void
}

export function createReceiptTelemetry(
  opts: { send?: ReceiptBatchSender; intervalMs?: number; now?: () => number; doc?: Document | null } = {},
): ReceiptTelemetry {
  const send = opts.send ?? defaultSender
  const now = opts.now ?? Date.now
  /** `event\u0000outcome` -> count. */
  const counts = new Map<string, number>()
  let backoffUntil = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let flushing: Promise<void> | undefined
  const doc = opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : opts.doc

  const total = () => [...counts.values()].reduce((a, b) => a + b, 0)

  const drain = async (): Promise<void> => {
    if (now() < backoffUntil || counts.size === 0) return
    // One entry per occurrence: the endpoint counts entries. Taken out first so concurrent counts
    // land in the map for the next flush.
    const taken = new Map(counts)
    counts.clear()
    const entries: ReceiptTelemetryEntry[] = []
    for (const [key, n] of taken) {
      const [event, outcome] = key.split('\u0000')
      for (let i = 0; i < n; i++) entries.push({ event, outcome })
    }
    for (let off = 0; off < entries.length; off += MAX_BATCH) {
      const batch = entries.slice(off, off + MAX_BATCH)
      let answer: 'ok' | 'rate_limited' | 'rejected'
      try {
        answer = await send(batch)
      } catch {
        answer = 'rejected'
      }
      if (answer === 'rate_limited') {
        backoffUntil = now() + BACKOFF_MS
        // Keep what was not sent, aggregated, for after the back-off.
        for (const e of entries.slice(off)) add(e.event, e.outcome)
        return
      }
      // 'rejected' drops this batch only: never retried.
    }
  }

  const add = (event: string, outcome: string) => {
    const key = `${event}\u0000${outcome}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (total() > MAX_QUEUE) {
      const first = counts.keys().next().value
      if (first !== undefined) {
        const left = (counts.get(first) ?? 1) - 1
        if (left > 0) counts.set(first, left)
        else counts.delete(first)
      }
    }
  }

  const flush = (): Promise<void> => {
    flushing ??= drain().finally(() => {
      flushing = undefined
    })
    return flushing
  }
  const flushQuietly = () => void flush().catch(() => undefined)
  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden') flushQuietly()
  }
  const ensureStarted = () => {
    if (timer !== undefined) return
    timer = setInterval(flushQuietly, opts.intervalMs ?? FLUSH_INTERVAL_MS)
    doc?.addEventListener('visibilitychange', onVisibility)
  }

  return {
    count(event, outcome) {
      try {
        if (!isKnown(event, outcome)) return
        ensureStarted()
        add(event, outcome)
      } catch {
        // telemetry never fails its caller
      }
    },
    flush,
    pending: () => total(),
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      doc?.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

let shared: ReceiptTelemetry | undefined

/** Count one receipt event. Never throws; an unknown pair is dropped. */
export function countReceiptEvent(event: string, outcome: string): void {
  try {
    shared ??= createReceiptTelemetry()
    shared.count(event, outcome)
  } catch {
    // never
  }
}

/** Flush hook for App/visibility handlers. Never rejects. */
export function flushReceiptTelemetry(): Promise<void> {
  return (shared?.flush() ?? Promise.resolve()).catch(() => undefined)
}

/** Test seam. */
export function setReceiptTelemetry(t: ReceiptTelemetry | undefined): void {
  shared?.stop()
  shared = t
}
