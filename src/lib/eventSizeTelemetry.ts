import type { Event } from 'nostr-tools'

/**
 * Nostr event size telemetry for the browser wallet (imani-wallet#532).
 *
 * The wallet cannot be scraped, so it batches {kind, bytes, path} and POSTs them to
 * gateway-customer's `POST /api/v1/telemetry/event-sizes` (NIP-98), which records them with
 * source="wallet" and applies its own limits. Only relay publishes are recorded here: the event
 * store mirror (`POST /api/v1/nostr/events`) is counted server-side, so counting it here too would
 * double it.
 *
 * Never throws into a publish, never delays one, never retries: a failed batch is dropped. Sends
 * nothing but kind, bytes and path, and nothing at all without an unlocked local signer.
 */

export interface EventSizeEntry {
  kind: number
  bytes: number
  path: 'relay'
}

export const ENDPOINT = '/api/v1/telemetry/event-sizes'
export const FLUSH_INTERVAL_MS = 30_000
export const FLUSH_AT = 50
export const MAX_QUEUE = 500
/** The endpoint accepts 1 to 100 entries per request. */
export const MAX_BATCH = 100

/** UTF-8 bytes of the event JSON as it goes on the wire in ["EVENT", event]. */
export function eventBytes(event: Event): number {
  return new TextEncoder().encode(JSON.stringify(event)).length
}

/** Sends one batch. Resolves whether it was accepted; may throw, the caller swallows it. */
export type BatchSender = (events: EventSizeEntry[]) => Promise<boolean>

/**
 * The default sender: NIP-98 signed with the installed wallet signer, `keepalive` so a flush on
 * `visibilitychange` survives the page going away (sendBeacon cannot carry an Authorization
 * header). Returns false without sending when signed out or locked: a signer that would prompt
 * (or a remote one) must never be asked to sign telemetry.
 */
export const defaultSender: BatchSender = async (events) => {
  const { getSigner } = await import('./nap')
  let signer
  try {
    signer = getSigner()
  } catch {
    return false
  }
  if (typeof signer.hasKey === 'function' && !signer.hasKey()) return false
  const { signedFetch } = await import('./nip98')
  const response = await signedFetch(ENDPOINT, 'POST', { events }, signer, { keepalive: true })
  return response.ok
}

export interface Reporter {
  record(event: Event): void
  flush(): Promise<void>
  /** Test seam: what is waiting. */
  pending(): number
  stop(): void
}

export function createReporter(opts: { send?: BatchSender; intervalMs?: number; doc?: Document | null } = {}): Reporter {
  const send = opts.send ?? defaultSender
  let queue: EventSizeEntry[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  // One flush at a time (review of #535): with a slow or hanging gateway, every crossing of FLUSH_AT
  // started another loop, 30 requests in flight for 1,500 events. While one runs, the queue just
  // grows to MAX_QUEUE (oldest dropped) and the running loop drains it.
  let flushing: Promise<void> | undefined
  const doc = opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : opts.doc

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.slice(0, MAX_BATCH)
      queue = queue.slice(batch.length)
      try {
        // A false (no signer, rejected) or a throw both drop the batch: telemetry never retries.
        await send(batch)
      } catch {
        // dropped
      }
    }
  }
  const flush = (): Promise<void> => {
    flushing ??= drain().finally(() => {
      flushing = undefined
    })
    return flushing
  }
  const flushQuietly = () => {
    void flush().catch(() => undefined)
  }
  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden') flushQuietly()
  }
  const ensureStarted = () => {
    if (timer !== undefined) return
    timer = setInterval(flushQuietly, opts.intervalMs ?? FLUSH_INTERVAL_MS)
    doc?.addEventListener('visibilitychange', onVisibility)
  }

  return {
    record(event) {
      try {
        ensureStarted()
        queue.push({ kind: event.kind, bytes: eventBytes(event), path: 'relay' })
        if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE)
        if (queue.length >= FLUSH_AT) flushQuietly()
      } catch {
        // never into a publish
      }
    },
    flush,
    pending: () => queue.length,
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      doc?.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

let shared: Reporter | undefined

/** Record one relay publish. Never throws. */
export function recordRelayPublish(event: Event): void {
  try {
    shared ??= createReporter()
    shared.record(event)
  } catch {
    // never into a publish
  }
}
