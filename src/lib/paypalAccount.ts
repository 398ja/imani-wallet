/**
 * A stall's PayPal seller account, from the stall's own side: `stripeAccount.ts` for PayPal.
 *
 * The same four things (see where they stand, connect, come back to finish, disconnect), the same
 * session-scoped calls to `imani-merchant` (`/api/v1/merchant/paypal`, which proxies to
 * payment-adapter's `/api/v1/paypal/connect`), and the same answer shape, so the Card payments
 * screen reads either processor with one code path. payment-adapter answers PayPal with Stripe's
 * status words and fields (ADR 0002): `charges_enabled` here means "PayPal will take a card for
 * this seller today".
 *
 * PayPal hosts onboarding, so the onboarding link is followed with a full navigation and, as with
 * Stripe, only when it is on one of PayPal's own https hosts.
 */
import type { StripeAccountStatus, StripeResult } from './stripeAccount'

const PAYPAL_PATH = '/api/v1/merchant/paypal'

/** Long enough for PayPal to answer through two hops, short enough to fail. */
const TIMEOUT_MS = 15000

/** The Stripe status shape: one screen, one parser. `stripeAccountId` holds PayPal's merchant id. */
export type PaypalAccountStatus = StripeAccountStatus
export type PaypalResult = StripeResult

/** Where PayPal sends the merchant back to. Absolute, because PayPal redirects a browser. */
function returnUrl(): string {
  return `${window.location.origin}/settings/payments?paypal=return`
}

async function call(path: string, init: RequestInit): Promise<PaypalResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${PAYPAL_PATH}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal,
    })
    if (response.status === 204) return { kind: 'ok', status: disconnectedPaypal() }
    if (!response.ok) {
      if (response.status === 401) {
        return { kind: 'refused', reason: 'Your session has expired. Sign in again to manage card payments.' }
      }
      return { kind: 'refused', reason: await refusalReason(response) }
    }
    return { kind: 'ok', status: parsePaypal(await response.json()) }
  } catch (error) {
    return {
      kind: 'unreachable',
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'That took too long. Nothing was changed.'
          : 'Could not reach your account service. Nothing was changed.',
    }
  } finally {
    clearTimeout(timer)
  }
}

/** The service's own words when it sends them, capped, as `stripeAccount.ts` does. */
async function refusalReason(response: Response): Promise<string> {
  const generic = 'PayPal could not be reached through your account. Please try again.'
  try {
    const body: unknown = await response.json()
    const message = (body as { message?: unknown })?.message
    if (typeof message === 'string' && message.trim()) {
      return message.length > 200 ? generic : message
    }
  } catch {
    // Not JSON: the generic sentence is still true.
  }
  return generic
}

export function fetchPaypalStatus(): Promise<PaypalResult> {
  return call('/status', { method: 'GET' })
}

/** Begin, or resume, connecting a PayPal seller account. Answers with PayPal's onboarding link. */
export function connectPaypal(): Promise<PaypalResult> {
  return call('/connect', { method: 'POST', body: JSON.stringify({ return_url: returnUrl() }) })
}

/** Ask for a fresh onboarding link and re-read the seller, after the merchant comes back. */
export function refreshPaypal(): Promise<PaypalResult> {
  return call(`/refresh?return_url=${encodeURIComponent(returnUrl())}`, { method: 'GET' })
}

/** Re-read the seller without minting a new link. */
export const checkPaypal = fetchPaypalStatus

export function disconnectPaypal(): Promise<PaypalResult> {
  return call('/disconnect', { method: 'DELETE' })
}

export function disconnectedPaypal(): PaypalAccountStatus {
  return { status: 'not_connected', chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, requirementsDue: [] }
}

/** Defensive, as Stripe's: every boolean defaults to false, so "unknown" never reads as "can charge". */
function parsePaypal(body: unknown): PaypalAccountStatus {
  const raw = (body ?? {}) as Record<string, unknown>
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined
  return {
    status: str(raw.status) ?? 'unknown',
    stripeAccountId: str(raw.paypal_merchant_id),
    chargesEnabled: raw.charges_enabled === true,
    payoutsEnabled: raw.payouts_enabled === true,
    detailsSubmitted: raw.details_submitted === true,
    defaultCurrency: str(raw.default_currency),
    requirementsDue: Array.isArray(raw.requirements_due)
      ? raw.requirements_due.filter((r): r is string => typeof r === 'string')
      : [],
    onboardingUrl: typeof raw.onboarding_url === 'string' && paypalUrlRejection(raw.onboarding_url) === null
      ? new URL(raw.onboarding_url).toString()
      : undefined,
    onboardingUrlRejected:
      raw.onboarding_url === undefined || raw.onboarding_url === null
        ? undefined
        : (paypalUrlRejection(raw.onboarding_url) ?? undefined),
  }
}

/**
 * Why an onboarding link was refused, or null when it is PayPal's. The link goes into
 * `window.location.href`, so it must be an https URL on `paypal.com` or a subdomain (sandbox
 * included: `www.sandbox.paypal.com`). An allowlist, because "looks like PayPal" is what a phisher
 * registers.
 */
export function paypalUrlRejection(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'PayPal did not send a setup link.'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'PayPal sent a setup link that is not a valid address.'
  }
  if (url.protocol !== 'https:') return `Refused a setup link that was not https (${url.protocol}//).`
  const host = url.hostname.toLowerCase()
  if (host !== 'paypal.com' && !host.endsWith('.paypal.com')) {
    return `Refused a setup link that was not a PayPal address (${url.hostname}).`
  }
  return null
}
