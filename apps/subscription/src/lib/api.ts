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

export type Term = 'monthly' | 'annual'

export interface Plan {
  tier: string
  features: string[]
  limits: LicenceLimits
  terms: Term[]
  /** What Stripe Checkout charges, per term, in minor units. Absent while Stripe cannot be read. */
  prices?: Partial<Record<Term, { amount: number; currency: string }>>
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

/**
 * Plan names as www.imani.casa/pricing publishes them. The catalog's `free` tier is sold as Starter.
 * Only the tiers the service lists are shown: a partnership tier (Town / BID Partner) is arranged
 * with us, has no card price, and is never offered on this site.
 */
export const TIER_NAMES: Record<string, string> = { free: 'Starter', basic: 'Basic', pro: 'Pro', custom: 'Custom' }

/**
 * What each plan includes beyond the limits the licence enforces, as the pricing page lists it.
 * These are services we provide (the badge, the listing, support), so they are copy, not catalog:
 * the wallet has nothing to enforce. Limits and paid features always come from the catalog.
 */
export const PLAN_COPY: Record<string, { bestFor: string; includes: string[] }> = {
  free: { bestFor: 'Trying Imani', includes: ['Help centre and YouTube video tutorials'] },
  basic: {
    bestFor: 'Independent shops, cafés, salons',
    includes: ['Verified business badge', 'Standard listing on the Imani gifting site', 'Setup help from our support team', 'Email support'],
  },
  pro: {
    bestFor: 'Busy shops, multi-site and online sellers',
    includes: ['Verified business badge', 'Featured placement on the Imani gifting site', 'Setup help from our support team', 'Email support'],
  },
}

/** The plan the pricing page highlights. */
export const HIGHLIGHTED_TIER = 'pro'

export function money(minor: number, currency: string, fraction = false): string {
  const whole = minor % 100 === 0 && !fraction
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(minor / 100)
}

/** "£8/month", "£70/year": a plan's price for a term, or null when it has none. */
export function priceLine(plan: Plan, term: Term): string | null {
  const p = plan.prices?.[term]
  if (!p) return null
  return `${money(p.amount, p.currency)}/${term === 'monthly' ? 'month' : 'year'}`
}

/** Percent saved by paying yearly instead of twelve months, rounded down. Null if not both. */
export function yearlySaving(plan: Plan): number | null {
  const m = plan.prices?.monthly
  const y = plan.prices?.annual
  if (!m || !y || m.currency !== y.currency || m.amount <= 0) return null
  const pct = Math.floor((1 - y.amount / (12 * m.amount)) * 100)
  return pct > 0 ? pct : null
}

export function featureName(f: string): string {
  return f === 'api' ? 'API access' : f === 'ecommerce' ? 'Online shop checkout codes' : f === 'terminals' ? 'Extra tills' : f
}

/** "Up to £100 of vouchers in total", "Unlimited voucher issuance": the plan's sales limit in words. */
export function salesLine(limits: LicenceLimits, currency = 'GBP'): string {
  const s = limits.sales
  if (s === null) return 'Unlimited voucher issuance'
  if (!s) return ''
  const own = s.amounts[currency] !== undefined
  const amount = (own ? s.amounts[currency] : s.amounts.USD) ?? 0
  const value = money(amount, own ? currency : 'USD')
  return s.period === 'month'
    ? `Up to ${value} of vouchers a month`
    : s.period === 'lifetime'
      ? `Up to ${value} of vouchers in total`
      : `Up to ${value} of vouchers`
}

export function tillsLine(limits: LicenceLimits): string {
  const t = limits.terminals
  if (t === null) return 'Unlimited tills'
  if (t === undefined) return ''
  return t === 1 ? 'Your device plus 1 till' : `Your device plus ${t} tills`
}

export function date(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
