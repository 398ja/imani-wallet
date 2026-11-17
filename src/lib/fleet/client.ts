import { nip98Header, type RequestSigner } from '../nip98'
import { normaliseSnapshotCode, displaySnapshotCode } from '../snapshot/code'
import type { HeldRequest } from './state'

/**
 * The fleet registry client (#591 contract C4). Every request is NIP-98 signed by the FLEET key,
 * never the session signer, and sent with `credentials: 'omit'`, so the gateway session cookie
 * (which names the wallet) never reaches support. Every value the server sends is clamped (C6):
 * the server is not trusted to keep the client within its budgets.
 */
export const CLIENTS_PATH = '/api/v1/support/fleet/clients'
export const HEARTBEAT_PATH = '/api/v1/support/fleet/heartbeat'
export const SELF_PATH = '/api/v1/support/fleet/clients/self'

export const MAX_FLEET_BYTES = 5 * 1024 * 1024
export const MAX_HISTORY_DAYS = 7
/** FLEET_REQUEST_TTL (72 h) plus 5 minutes of clock skew. */
export const MAX_REQUEST_TTL_S = 72 * 3600 + 300
export const DEFAULT_HEARTBEAT_S = 900
export const DEFAULT_JITTER_S = 120
const MIN_HEARTBEAT_S = 300
const MAX_HEARTBEAT_S = 86400

export type Platform = 'android' | 'ios' | 'pwa' | 'web'

export interface FleetHttp {
  fetch: typeof fetch
  signer: RequestSigner
  now?: () => number
}

export class FleetHttpError extends Error {
  constructor(readonly status: number) {
    super(`Fleet request failed (${status}).`)
    this.name = 'FleetHttpError'
  }
}

async function send(http: FleetHttp, path: string, method: 'POST' | 'DELETE', payload?: unknown): Promise<Response> {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const headers: Record<string, string> = { Authorization: await nip98Header(path, method, body, http.signer) }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return http.fetch(path, { method, headers, body, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
}

const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined)

export interface Timing {
  heartbeatSeconds: number
  jitterSeconds: number
}

/** heartbeat in [5 min, 24 h], jitter in [0, heartbeat / 2]; junk falls back to the defaults. */
export function clampTiming(b: Record<string, unknown>): Timing {
  const hbRaw = int(b.heartbeat_seconds)
  const heartbeatSeconds = hbRaw === undefined ? DEFAULT_HEARTBEAT_S : Math.min(MAX_HEARTBEAT_S, Math.max(MIN_HEARTBEAT_S, hbRaw))
  const jRaw = int(b.jitter_seconds)
  const jitterSeconds = jRaw === undefined ? (hbRaw === undefined ? DEFAULT_JITTER_S : Math.min(DEFAULT_JITTER_S, heartbeatSeconds / 2)) : Math.min(Math.floor(heartbeatSeconds / 2), Math.max(0, jRaw))
  return { heartbeatSeconds, jitterSeconds }
}

const ROUND_RE = /^F\d{12}$/

/**
 * A server request as something this client will hold, or null. Clamps max_bytes (<= 5 MB),
 * history_days (<= 7) and expires_at (<= now + 72 h + 5 min); refuses a past expiry, a code that
 * fails the Luhn check, and a round that is not `F` + yyyyMMddHHmm.
 */
export function clampRequest(r: unknown, nowMs: number): HeldRequest | null {
  if (!r || typeof r !== 'object') return null
  const b = r as Record<string, unknown>
  if (typeof b.code !== 'string' || b.code.length > 32) return null
  const n = normaliseSnapshotCode(b.code)
  if (!n.ok) return null
  if (typeof b.round !== 'string' || !ROUND_RE.test(b.round)) return null
  const nowS = Math.floor(nowMs / 1000)
  const exp = int(b.expires_at)
  if (exp === undefined || exp <= nowS) return null
  const mb = int(b.max_bytes)
  if (mb !== undefined && mb <= 0) return null
  const hd = int(b.history_days)
  return {
    code: displaySnapshotCode(n.canonical),
    round: b.round,
    expiresAt: Math.min(exp, nowS + MAX_REQUEST_TTL_S),
    maxBytes: mb === undefined ? MAX_FLEET_BYTES : Math.min(mb, MAX_FLEET_BYTES),
    historyDays: hd === undefined ? MAX_HISTORY_DAYS : Math.min(MAX_HISTORY_DAYS, Math.max(0, hd)),
  }
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  try {
    const b = (await res.json()) as unknown
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function register(http: FleetHttp, body: { consent_version: number; app_version: string; platform: Platform }): Promise<Timing> {
  const res = await send(http, CLIENTS_PATH, 'POST', { consent_version: body.consent_version, app_version: body.app_version, platform: body.platform })
  if (res.status !== 200 && res.status !== 201) throw new FleetHttpError(res.status)
  return clampTiming(await bodyOf(res))
}

export type LastUpload = { round: string; state: 'received' | 'deleted' }
export type HeartbeatResult =
  | ({ kind: 'ok'; request: HeldRequest | null; lastUpload: LastUpload | null } & Timing)
  | { kind: 'gone' }

export async function heartbeat(http: FleetHttp, body: { app_version: string; platform: Platform }): Promise<HeartbeatResult> {
  const res = await send(http, HEARTBEAT_PATH, 'POST', { app_version: body.app_version, platform: body.platform })
  if (res.status === 410) return { kind: 'gone' }
  if (res.status !== 200) throw new FleetHttpError(res.status)
  const b = await bodyOf(res)
  const lu = b.last_upload as Record<string, unknown> | null | undefined
  const lastUpload = lu && typeof lu === 'object' && typeof lu.round === 'string' && ROUND_RE.test(lu.round) && (lu.state === 'received' || lu.state === 'deleted')
    ? { round: lu.round, state: lu.state as LastUpload['state'] }
    : null
  return { kind: 'ok', ...clampTiming(b), request: clampRequest(b.snapshot_request, (http.now ?? Date.now)()), lastUpload }
}

/**
 * True when the server no longer knows this client: 204, or 410 (unknown client). NOT 404: that is
 * what the server answers while the fleet routes are unmounted (C4), and the row may still exist.
 */
export async function deregister(http: FleetHttp): Promise<boolean> {
  try {
    const res = await send(http, SELF_PATH, 'DELETE')
    return res.status === 204 || res.status === 200 || res.status === 410
  } catch {
    return false
  }
}
