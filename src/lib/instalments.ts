/**
 * Monthly payments: a buyer pays a stall a fixed amount each month, by card, into the stall's
 * own Stripe account, and each paid instalment issues one voucher (monthly payments spec).
 *
 * In code and docs this is an **Instalment plan** (`RecurringPlan` in payment-adapter). The
 * customer never sees that word: buttons say "Pay monthly" and "Start monthly payments", and
 * one payment within a plan is an instalment, never a "charge".
 *
 * ## Who is asking
 *
 * Starting is unsigned, like a one-off purchase: payment-adapter checks the stall, the amount
 * and the account before the buyer sees a card form. Listing, reading and stopping are
 * **signed requests** (NIP-98, ADR 0001): the buyer is whoever signed, so a wallet can only
 * ever see and stop its own plans. No key is ever sent as a parameter.
 *
 * Every route is under `/api/v1/checkout`, which the edge and the dev proxy already send to
 * payment-adapter. `/api/v1/purchases` is the purchase issuer's bearer-token surface and a
 * browser can never call it.
 */

import { signedFetch, type RequestSigner } from './nip98'

const START_PATH = '/api/v1/checkout/plan'
export const PLANS_PATH = '/api/v1/checkout/plans'

/** Long enough for a session to be created, short enough not to feel hung. */
const TIMEOUT_MS = 15000

/** How long a plan runs: a fixed number of months, or until the buyer stops it. */
export type PlanTerm = 3 | 6 | 12 | 'open'

/** The term chips, in the order they are offered. */
export const PLAN_TERMS: readonly PlanTerm[] = [3, 6, 12, 'open']

/** payment-adapter's statuses. Anything else is read as `UNKNOWN`, never as active. */
export type PlanStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'ORPHANED'
  | 'ATTENTION'
  | 'UNKNOWN'

const STATUSES: readonly PlanStatus[] = [
  'PENDING',
  'ACTIVE',
  'PAST_DUE',
  'COMPLETED',
  'CANCELLED',
  'ORPHANED',
  'ATTENTION',
]

export interface InstalmentPlan {
  planId: string
  stallPubkey: string
  status: PlanStatus
  amountMinor: number
  currency: string
  /** Null for a plan that runs until the buyer stops it. */
  totalInstalments: number | null
  instalmentsPaid: number
  /** The buyer pressed Stop: no further payments will be taken. */
  cancelRequested: boolean
  /** When Stop was pressed, ms, if it was. */
  cancelRequestedAt?: number
  createdAt?: number
}

export interface InstalmentPlanDetail {
  plan: InstalmentPlan
  /** The vouchers this plan's instalments issued, oldest first. */
  voucherIds: string[]
}

/** The stall's view: how many people pay it monthly, and what that comes to, per currency. */
export interface StallInstalmentSummary {
  activePlans: number
  monthlyTotals: { currency: string; amountMinor: number }[]
}

/** Why a plan could not be started, as the screen needs to say it. */
export type StartRefusal =
  | { kind: 'below-minimum'; minAmountMinor: number | null; reason: string }
  | { kind: 'not-offered'; reason: string }
  | { kind: 'not-eligible'; reason: string }
  | { kind: 'other'; reason: string }

export type StartResult =
  | { kind: 'ok'; checkoutUrl: string; planId: string }
  | { kind: 'error'; refusal: StartRefusal }

/**
 * Start a plan and get the Stripe page to send the buyer to.
 *
 * A wallet key is required: a plan delivers a voucher every month, and there is nowhere to
 * deliver one to without it. The caller sends a guest through log-in-and-come-back instead.
 */
export async function startInstalments(
  params: { stallPubkey: string; buyerPubkey: string; amountMinor: number; term: PlanTerm },
  fetchImpl: typeof fetch = fetch,
): Promise<StartResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetchImpl(START_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stallPubkey: params.stallPubkey,
        buyerPubkey: params.buyerPubkey,
        amountMinor: params.amountMinor,
        // Left out, not null, for an open-ended plan: the adapter reads absent as "until cancelled".
        ...(params.term === 'open' ? {} : { instalments: params.term }),
      }),
      signal: controller.signal,
    })
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    const checkoutUrl = typeof body?.checkoutUrl === 'string' ? body.checkoutUrl : undefined
    if (response.ok && checkoutUrl && isStripeCheckoutUrl(checkoutUrl)) {
      return { kind: 'ok', checkoutUrl, planId: typeof body?.planId === 'string' ? body.planId : '' }
    }
    if (response.ok) {
      return { kind: 'error', refusal: other('The payment page could not be opened. Nothing was charged.') }
    }
    return { kind: 'error', refusal: startRefusal(response.status, body) }
  } catch (error) {
    return {
      kind: 'error',
      refusal: other(
        error instanceof Error && error.name === 'AbortError'
          ? 'The payment page took too long to load. Nothing was charged.'
          : 'Could not reach the payment service. Nothing was charged.',
      ),
    }
  } finally {
    clearTimeout(timer)
  }
}

function other(reason: string): StartRefusal {
  return { kind: 'other', reason }
}

/**
 * The adapter's refusal in the screen's words. The code decides the category; the adapter's own
 * text is the fallback, because "this stall cannot accept card payments yet" is worth showing
 * verbatim and beats a generic failure.
 */
export function startRefusal(status: number, body: Record<string, unknown> | null): StartRefusal {
  const code = typeof body?.code === 'string' ? body.code : undefined
  const error = typeof body?.error === 'string' && body.error.length <= 200 ? body.error : undefined
  if (code === 'BELOW_MINIMUM') {
    const min = typeof body?.minAmountMinor === 'number' ? body.minAmountMinor : null
    return { kind: 'below-minimum', minAmountMinor: min, reason: error ?? 'That amount is below the minimum.' }
  }
  if (code === 'NOT_CONNECTED' || status === 404) {
    return { kind: 'not-offered', reason: "This stall doesn't offer monthly payments." }
  }
  if (code === 'ACCOUNT_NOT_ELIGIBLE') {
    return { kind: 'not-eligible', reason: "This stall can't take monthly payments yet." }
  }
  // The stall switched monthly payments off (or never saved it where it is enforced), or does not
  // offer this interval. Same words as a stall that never offered them.
  if (code === 'NOT_OFFERED' || code === 'INTERVAL_NOT_OFFERED') {
    return { kind: 'not-offered', reason: "This stall doesn't offer monthly payments." }
  }
  return other(error ? `${capitalise(error)}${/[.!?]$/.test(error) ? '' : '.'} Nothing was charged.` : 'Monthly payments could not be started. Nothing was charged.')
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Stripe's hosted Checkout, over https, and nothing else. This value goes into
 * `window.location.href`, so an unchecked string would be an open redirect one tap from a
 * card form.
 */
export function isStripeCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && (host === 'stripe.com' || host.endsWith('.stripe.com'))
  } catch {
    return false
  }
}

export type PlansResult<T> = { kind: 'ok'; value: T } | { kind: 'error'; reason: string }

/** The signed-in buyer's plans, newest first. */
export async function listInstalmentPlans(signer?: RequestSigner): Promise<PlansResult<InstalmentPlan[]>> {
  const result = await signedJson(PLANS_PATH, 'GET', signer)
  if (result.kind !== 'ok') return result
  return {
    kind: 'ok',
    value: Array.isArray(result.value)
      ? result.value.map(parsePlan).filter((p): p is InstalmentPlan => p !== null)
      : [],
  }
}

/** One plan and the vouchers it issued. 404 (not yours, or no such plan) reads as an error. */
export async function readInstalmentPlan(
  planId: string,
  signer?: RequestSigner,
): Promise<PlansResult<InstalmentPlanDetail>> {
  const result = await signedJson(`${PLANS_PATH}/${encodeURIComponent(planId)}`, 'GET', signer)
  if (result.kind !== 'ok') return result
  const body = (result.value ?? {}) as Record<string, unknown>
  const plan = parsePlan(body.plan)
  if (plan === null) return { kind: 'error', reason: 'This monthly payment could not be read.' }
  const voucherIds = Array.isArray(body.voucherIds)
    ? body.voucherIds.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128)
    : []
  return { kind: 'ok', value: { plan, voucherIds } }
}

/**
 * Stop a plan. Ends it at the end of the current period on the stall's account: no further
 * payments are taken, vouchers already received stay the buyer's, and nothing is refunded.
 */
export async function stopInstalmentPlan(
  planId: string,
  signer?: RequestSigner,
): Promise<PlansResult<InstalmentPlan>> {
  const result = await signedJson(`${PLANS_PATH}/${encodeURIComponent(planId)}/cancel`, 'POST', signer, true)
  if (result.kind !== 'ok') return result
  const plan = parsePlan(result.value)
  return plan === null ? { kind: 'error', reason: STOP_FAILED } : { kind: 'ok', value: plan }
}

/** The stall's own count and monthly total, signed by the stall. */
export async function fetchStallInstalmentSummary(
  stallPubkey: string,
  signer?: RequestSigner,
): Promise<PlansResult<StallInstalmentSummary>> {
  const result = await signedJson(`${PLANS_PATH}/summary?stall=${stallPubkey}`, 'GET', signer)
  if (result.kind !== 'ok') return result
  const body = (result.value ?? {}) as Record<string, unknown>
  const totals = Array.isArray(body.monthlyTotals)
    ? body.monthlyTotals
        .map((t) => t as Record<string, unknown>)
        .filter((t) => typeof t.currency === 'string' && typeof t.amountMinor === 'number')
        .map((t) => ({ currency: t.currency as string, amountMinor: t.amountMinor as number }))
    : []
  return {
    kind: 'ok',
    value: { activePlans: typeof body.activePlans === 'number' ? body.activePlans : 0, monthlyTotals: totals },
  }
}

export const STOP_FAILED = "We couldn't reach Stripe. Nothing was changed. Try again."

export const SETTINGS_PATH = `${PLANS_PATH}/settings`

/** How often a buyer may pay. Stripe's interval names. */
export type PlanInterval = 'week' | 'month' | 'year'

/** The stall's instalment offer as payment-adapter holds it: the switch the plan start enforces. */
export interface StallInstalmentSettings {
  enabled: boolean
  intervals: PlanInterval[]
}

const INTERVALS: readonly PlanInterval[] = ['week', 'month', 'year']

/**
 * Save the stall's offer where it is ENFORCED. The published `acceptsInstalments` only shows or
 * hides "Pay monthly"; payment-adapter refuses a plan unless this was saved, signed by the stall
 * (NIP-98 with the body's hash, so the signature cannot be replayed with other settings).
 *
 * `intervals` left out keeps whatever the stall already offers (monthly for a new stall), so this
 * screen, which only knows the on/off switch, never erases a frequency chosen elsewhere.
 */
export async function saveStallInstalmentSettings(
  settings: { enabled: boolean; intervals?: PlanInterval[] },
  signer?: RequestSigner,
): Promise<PlansResult<StallInstalmentSettings>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await signedFetch(
      SETTINGS_PATH,
      'POST',
      settings.intervals ? { enabled: settings.enabled, intervals: settings.intervals } : { enabled: settings.enabled },
      signer,
      { signal: controller.signal },
    )
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (response.ok && body && typeof body.enabled === 'boolean') {
      return { kind: 'ok', value: parseSettings(body) }
    }
    if (response.status === 401) return { kind: 'error', reason: 'Your session has expired. Sign in again.' }
    return { kind: 'error', reason: 'Monthly payments could not be saved. Nothing was changed. Try again.' }
  } catch {
    return { kind: 'error', reason: 'Could not reach the payment service. Nothing was changed. Try again.' }
  } finally {
    clearTimeout(timer)
  }
}

/** The stall's offer as payment-adapter holds it. Public, like the profile flag. Null if it could not be read. */
export async function fetchStallInstalmentSettings(
  stallPubkey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StallInstalmentSettings | null> {
  try {
    const response = await fetchImpl(`${SETTINGS_PATH}?stall=${encodeURIComponent(stallPubkey)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
    return body && typeof body.enabled === 'boolean' ? parseSettings(body) : null
  } catch {
    return null
  }
}

function parseSettings(body: Record<string, unknown>): StallInstalmentSettings {
  const intervals = Array.isArray(body.intervals)
    ? body.intervals.filter((i): i is PlanInterval => INTERVALS.includes(i as PlanInterval))
    : []
  return { enabled: body.enabled === true, intervals }
}

async function signedJson(
  path: string,
  method: 'GET' | 'POST',
  signer: RequestSigner | undefined,
  isStop = false,
): Promise<PlansResult<unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await signedFetch(path, method, undefined, signer, { signal: controller.signal })
    const body = (await response.json().catch(() => null)) as unknown
    if (response.ok) return { kind: 'ok', value: body }
    const message = (body as { error?: unknown } | null)?.error
    if (response.status === 401) return { kind: 'error', reason: 'Your session has expired. Sign in again.' }
    if (response.status === 409 && typeof message === 'string') {
      return {
        kind: 'error',
        reason: message.includes('ask the stall')
          ? 'This stall disconnected from Imani. Ask them to stop it in Stripe.'
          : 'This monthly payment has already ended.',
      }
    }
    if (isStop && (response.status === 502 || response.status >= 500)) return { kind: 'error', reason: STOP_FAILED }
    if (response.status === 404) return { kind: 'error', reason: 'This monthly payment was not found.' }
    return { kind: 'error', reason: isStop ? STOP_FAILED : 'Monthly payments could not be loaded. Try again.' }
  } catch {
    return { kind: 'error', reason: isStop ? STOP_FAILED : 'Monthly payments could not be loaded. Try again.' }
  } finally {
    clearTimeout(timer)
  }
}

const HEX64 = /^[0-9a-f]{64}$/

/**
 * One plan off the wire, defensively. Unknown statuses read as `UNKNOWN`, which no screen treats
 * as active or past due; a plan without an id, stall or amount is dropped.
 */
export function parsePlan(raw: unknown): InstalmentPlan | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.planId !== 'string' || r.planId === '') return null
  if (typeof r.stallPubkey !== 'string' || !HEX64.test(r.stallPubkey)) return null
  if (typeof r.amountMinor !== 'number' || !Number.isFinite(r.amountMinor) || r.amountMinor <= 0) return null
  const status = STATUSES.includes(r.status as PlanStatus) ? (r.status as PlanStatus) : 'UNKNOWN'
  return {
    planId: r.planId,
    stallPubkey: r.stallPubkey,
    status,
    amountMinor: r.amountMinor,
    currency: typeof r.currency === 'string' ? r.currency.toLowerCase() : '',
    totalInstalments: typeof r.totalInstalments === 'number' && r.totalInstalments > 0 ? r.totalInstalments : null,
    instalmentsPaid: typeof r.instalmentsPaid === 'number' && r.instalmentsPaid >= 0 ? r.instalmentsPaid : 0,
    cancelRequested: r.cancelRequested === true,
    cancelRequestedAt: toMs(r.cancelRequestedAt),
    createdAt: toMs(r.createdAt),
  }
}

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

// ---- Words ----------------------------------------------------------------------------------

/** "£40", "£40.50", in the plan's own currency. */
export function formatMoney(amountMinor: number, currency: string): string {
  const code = (currency || 'gbp').toUpperCase()
  const whole = amountMinor % 100 === 0
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amountMinor / 100)
  } catch {
    return `${(amountMinor / 100).toFixed(whole ? 0 : 2)} ${code}`
  }
}

/**
 * The live summary under the form, doing the arithmetic so the customer does not have to.
 * "£40 a month for 6 months, £240 in total. First payment today. A new voucher arrives with
 * each payment."
 */
export function planSummary(amountMinor: number, currency: string, term: PlanTerm): string {
  const each = formatMoney(amountMinor, currency)
  if (term === 'open') return `${each} a month until you cancel. First payment today.`
  return `${each} a month for ${term} months, ${formatMoney(amountMinor * term, currency)} in total. First payment today. A new voucher arrives with each payment.`
}

/** The term chip's label. */
export function termLabel(term: PlanTerm): string {
  return term === 'open' ? 'Until I cancel' : `${term} months`
}

/** Always visible beside the button. Wording pending legal review (spec, Open items). */
export const CONSENT_LINE = "You can stop at any time. Vouchers you've already received stay yours."

/** "3 of 6 paid", or "3 paid" for an open-ended plan. */
export function progressLabel(plan: InstalmentPlan): string {
  return plan.totalInstalments === null
    ? `${plan.instalmentsPaid} paid`
    : `${plan.instalmentsPaid} of ${plan.totalInstalments} paid`
}

export interface StatusWords {
  chip: string
  /** One sentence under the chip. */
  meaning: string
  /** Chip tone. Never the only signal: the chip always carries words too. */
  tone: 'ok' | 'warn' | 'neutral' | 'danger'
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })

/**
 * Every adapter status to a chip and a sentence. A plan the buyer has stopped reads as stopped
 * whatever its status, because "Active" on a plan they just stopped would make them press Stop
 * again and wonder whether it worked.
 */
export function statusWords(plan: InstalmentPlan): StatusWords {
  if (plan.cancelRequested && (plan.status === 'ACTIVE' || plan.status === 'PAST_DUE')) {
    return { chip: 'Stopped', meaning: 'Stopped. No further payments.', tone: 'neutral' }
  }
  switch (plan.status) {
    case 'ACTIVE':
      return { chip: 'Active', meaning: 'Paying monthly.', tone: 'ok' }
    case 'PAST_DUE':
      return { chip: 'Payment failed', meaning: "Your last payment didn't go through. Stripe will try again.", tone: 'danger' }
    case 'COMPLETED':
      return {
        chip: 'Finished',
        meaning: plan.totalInstalments ? `All ${plan.totalInstalments} payments made.` : 'All payments made.',
        tone: 'neutral',
      }
    case 'CANCELLED':
      return {
        chip: 'Cancelled',
        meaning: plan.cancelRequestedAt ? `You stopped this on ${DATE.format(plan.cancelRequestedAt)}.` : 'You stopped this.',
        tone: 'neutral',
      }
    case 'ORPHANED':
      return { chip: 'Needs the stall', meaning: 'This stall disconnected from Imani. Ask them to stop it in Stripe.', tone: 'warn' }
    case 'ATTENTION':
      return { chip: 'Under review', meaning: 'Something needs checking. Imani support will contact the stall.', tone: 'warn' }
    case 'PENDING':
      return { chip: 'Not finished', meaning: "You didn't finish paying.", tone: 'neutral' }
    default:
      return { chip: 'Unknown', meaning: "We couldn't read this monthly payment's state.", tone: 'neutral' }
  }
}

/** Plans the buyer still has a relationship with: worth a Settings row, a stall line, a banner. */
export function isRunning(plan: InstalmentPlan): boolean {
  return (plan.status === 'ACTIVE' || plan.status === 'PAST_DUE') && !plan.cancelRequested
}

/** Plans whose last payment failed, for the home banner. Stopped plans are not nagged about. */
export function pastDue(plans: InstalmentPlan[]): InstalmentPlan[] {
  return plans.filter((p) => p.status === 'PAST_DUE' && !p.cancelRequested)
}
