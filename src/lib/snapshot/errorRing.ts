import { scrub } from './scrub'
import type { ErrorEntry } from './types'

/**
 * A bounded ring of recent errors for the support snapshot (#589 phase 1b, section 4).
 *
 * Nothing raw is ever kept, in memory or on disk: on the way in, each error is reduced to its class,
 * an optional code, a message TEMPLATE (the PII scrubber's placeholders, then numbers as `<n>`) and
 * stack frames as `file:line:col` with the origin and query string removed. So the ring itself can
 * be read by a snapshot without a second redaction step deciding what was safe.
 */
const KEY = 'imani-wallet:error-ring'
const MAX = 50

let ring: ErrorEntry[] | null = null

function load(): ErrorEntry[] {
  if (ring) return ring
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]')
    ring = Array.isArray(v) ? (v as ErrorEntry[]).slice(-MAX) : []
  } catch {
    ring = []
  }
  return ring
}

/** Placeholders for PII and secrets, then numbers, so variable parts never survive. */
export function templateOf(message: string): string {
  return scrub(message)
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .slice(0, 300)
}

function frames(stack: string | undefined): string[] {
  if (!stack) return []
  const out: string[] = []
  for (const line of stack.split('\n').slice(1, 13)) {
    const m = /(?:https?:\/\/[^/\s)]+)?\/?((?:src|packages|assets|node_modules)\/[\w./-]+?)(?:\?[^:)]*)?:(\d+)(?::(\d+))?/.exec(line)
    if (m) out.push(`${m[1]}:${m[2]}${m[3] ? ':' + m[3] : ''}`)
  }
  return out
}

export function recordError(error: unknown, at = Date.now()): void {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-error thrown')
  const code = (e as Error & { code?: unknown }).code
  const entry: ErrorEntry = {
    at,
    name: /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error',
    code: typeof code === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(code) ? code : undefined,
    template: templateOf(e.message ?? ''),
    frames: frames(e.stack),
  }
  const r = load()
  r.push(entry)
  if (r.length > MAX) r.splice(0, r.length - MAX)
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(r))
  } catch {
    /* quota: the in-memory ring still has it */
  }
}

export function recentErrors(): ErrorEntry[] {
  return [...load()]
}

export function clearErrors(): void {
  ring = []
  try {
    globalThis.localStorage?.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}

/** Wire the ring to uncaught errors and rejections. Called once from main.tsx. */
export function installErrorRing(target: Window = window): void {
  target.addEventListener('error', (ev) => recordError((ev as ErrorEvent).error ?? (ev as ErrorEvent).message))
  target.addEventListener('unhandledrejection', (ev) => recordError((ev as PromiseRejectionEvent).reason))
}
