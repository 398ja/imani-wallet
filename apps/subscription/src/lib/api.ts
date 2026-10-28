import type { LicenceLimits } from '@imani/licence'
import { nip19 } from 'nostr-tools'

/** The path the site is mounted under ('' in production, the root of its origin), from Vite's base. */
export const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '')

/** An API path on this site: '/v1/me' -> `${BASE}/v1/me`. */
export const apiPath = (path: string) => `${BASE}${path}`

/** Raised when the session is gone (401): the app goes back to signing in through the wallet. */
export class SessionEnded extends Error {}

/**
 * A same-origin call that rides the session cookie. Nothing is signed per request: the NAP login
 * did that once (lib/session.ts), and the cookie is HttpOnly, so script never sees it.
 */
function call(path: string, method: 'GET' | 'POST', payload?: unknown): Promise<Response> {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  return fetch(apiPath(path), {
    method,
    body,
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
  })
}

export interface Plan {
  tier: string
  features: string[]
  limits: LicenceLimits
  terms: Array<'monthly' | 'annual'>
}

export interface MySubscription {
  subscription_id: string
  tier: string
  term: string
  kind: 'subscription' | 'custom'
  status: 'active' | 'cancelled' | 'revoked'
  limits?: LicenceLimits
  has_card: boolean
  licences: Array<{ valid_from: number; valid_to: number; state: string }>
}

export interface Me {
  pubkey: string
  roles: string[]
  admin: boolean
  subscriptions: MySubscription[]
}

async function read<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (r.status === 401) throw new SessionEnded(body.error ?? 'Your session has ended.')
  if (!r.ok) throw new Error(body.error ?? `Something went wrong (${r.status}).`)
  return body
}

export const api = {
  plans: () => fetch(apiPath('/v1/plans')).then((r) => read<Plan[]>(r)),
  me: () => call('/v1/me', 'GET').then((r) => read<Me>(r)),
  checkout: (tier: string, term: string) => call('/v1/checkout', 'POST', { tier, term }).then((r) => read<{ url: string }>(r)),
  portal: () => call('/v1/portal', 'POST').then((r) => read<{ url: string }>(r)),
  resend: () => call('/v1/licences/resend', 'POST').then((r) => read<{ sent: number }>(r)),
  grant: (body: Record<string, unknown>) =>
    call('/v1/admin/grants', 'POST', body).then((r) => read<{ subscription_id: string; state: string }>(r)),
  revoke: (subscription_id: string, reason: string) =>
    call('/v1/admin/revoke', 'POST', { subscription_id, reason }).then((r) => read<{ revoked: string }>(r)),
}

export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey)
}

/** Accept an npub or 64 hex, for the admin's "which stall" field. */
export function toPubkeyHex(input: string): string | null {
  const v = input.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  try {
    const d = nip19.decode(v)
    return d.type === 'npub' ? (d.data as string) : null
  } catch {
    return null
  }
}

export const TIER_NAMES: Record<string, string> = { free: 'Free', basic: 'Basic', pro: 'Pro', custom: 'Custom' }

export function featureName(f: string): string {
  return f === 'api' ? 'API access' : f === 'ecommerce' ? 'Online shop checkout codes' : f === 'terminals' ? 'Extra tills' : f
}

/** "£1,000 a month", "£100 in total", "No limit": the plan's sales limit in words. */
export function salesLine(limits: LicenceLimits, currency = 'GBP'): string {
  const s = limits.sales
  if (s === null) return 'Sell without limit'
  if (!s) return ''
  const amount = s.amounts[currency] ?? s.amounts.USD
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: s.amounts[currency] ? currency : 'USD', maximumFractionDigits: 0 }).format(
    (amount ?? 0) / 100,
  )
  return s.period === 'month' ? `Sell up to ${money} a month` : s.period === 'lifetime' ? `Sell up to ${money} in total` : `Sell up to ${money}`
}

export function tillsLine(limits: LicenceLimits): string {
  const t = limits.terminals
  if (t === null) return 'As many tills as you need'
  if (t === undefined) return ''
  return t === 1 ? 'Your own device plus 1 till' : `Your own device plus ${t} tills`
}

export function date(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
