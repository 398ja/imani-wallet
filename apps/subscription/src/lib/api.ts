import type { LicenceLimits } from '@imani/licence'

import { signedFetch, type Signer } from './signer'

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
  admin: boolean
  subscriptions: MySubscription[]
}

async function read<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(body.error ?? `Something went wrong (${r.status}).`)
  return body
}

export const api = {
  plans: () => fetch('/v1/plans').then((r) => read<Plan[]>(r)),
  me: (s: Signer) => signedFetch(s, '/v1/me', 'GET').then((r) => read<Me>(r)),
  checkout: (s: Signer, tier: string, term: string) =>
    signedFetch(s, '/v1/checkout', 'POST', { tier, term }).then((r) => read<{ url: string }>(r)),
  portal: (s: Signer) => signedFetch(s, '/v1/portal', 'POST').then((r) => read<{ url: string }>(r)),
  resend: (s: Signer) => signedFetch(s, '/v1/licences/resend', 'POST').then((r) => read<{ sent: number }>(r)),
  grant: (s: Signer, body: Record<string, unknown>) =>
    signedFetch(s, '/v1/admin/grants', 'POST', body).then((r) => read<{ subscription_id: string; state: string }>(r)),
  revoke: (s: Signer, subscription_id: string, reason: string) =>
    signedFetch(s, '/v1/admin/revoke', 'POST', { subscription_id, reason }).then((r) => read<{ revoked: string }>(r)),
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
