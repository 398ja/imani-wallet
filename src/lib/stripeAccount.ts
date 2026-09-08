/**
 * A stall's Stripe connection, from the stall's own side.
 *
 * Four things a merchant can do — see where they stand, connect, come back to
 * finish, and disconnect — and one thing that has to happen after any of them:
 * republish whether they take cards, because that flag is the only way a
 * shopper ever learns it.
 *
 * ## Why the wallet talks to `imani-merchant` here
 *
 * `payment-adapter` owns the Stripe account lifecycle and `imani-merchant`
 * mirrors it, and it is the mirror this screen reads. That is deliberate:
 * every one of these endpoints is self-scoped behind the session, so a stall
 * can only ever see and change its own. There is no pubkey parameter to abuse.
 *
 * ## `merchant-service` IS NOT DEPLOYED ON THIS STACK YET
 *
 * `src/lib/merchant.ts` records the state of play: gateway-portal answers 403
 * with an empty body for `/api/v1/merchant/*`, exactly as it does for a path it
 * has never heard of. `imani-deploy` lists `merchant-service` as a dependency
 * and defines no such service.
 *
 * So this screen will show "could not reach your account service" until that
 * service is deployed and routed. That is the correct behaviour rather than a
 * bug to work around here — every failure path leaves the stall's published
 * offer untouched, so an absent service means card payments stay off rather
 * than being wrongly advertised.
 *
 * Stated so the first person to open the screen knows what they are looking at.
 *
 * ## Everything here is a session call, not NIP-98
 *
 * `MerchantAuth.requirePubkey()` reads the NAP session, so these go out with
 * credentials and no signing. That is the opposite of issuance, and the reason
 * is that these are questions about an account rather than instructions to move
 * value.
 */

/** Where the merchant service lives, same-origin through the proxy. */
const STRIPE_PATH = '/api/v1/merchant/stripe'

/** Long enough for Stripe to answer through two hops, short enough to fail. */
const TIMEOUT_MS = 15000

/** What the merchant service says about a stall's connected account. */
export interface StripeAccountStatus {
  /** `not_connected`, `pending`, `active`, or whatever the service adds next. */
  status: string
  stripeAccountId?: string
  /** Whether Stripe will actually accept a charge today. The one that matters. */
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  /** The account's presentment currency, once it has one. */
  defaultCurrency?: string
  /** What Stripe still wants before it will enable charges. */
  requirementsDue: string[]
  /** Where to send the merchant to finish onboarding, when there is more to do. */
  onboardingUrl?: string
}

export type StripeResult =
  | { kind: 'ok'; status: StripeAccountStatus }
  /** Nothing was changed; the merchant can try again. */
  | { kind: 'unreachable'; reason: string }
  /** The service refused, with something worth showing. */
  | { kind: 'refused'; reason: string }

/**
 * Where Stripe sends the merchant back to.
 *
 * Absolute, because Stripe redirects a browser rather than calling us: a
 * relative path would resolve against stripe.com. Built from the live origin so
 * it is right in dev, staging and production without configuration.
 */
function returnUrls(): { return_url: string; refresh_url: string } {
  const base = `${window.location.origin}/settings/payments`
  return {
    // Distinguished so the screen can tell "finished" from "gave up and was
    // bounced back", which need different words.
    return_url: `${base}?stripe=return`,
    refresh_url: `${base}?stripe=refresh`,
  }
}

async function call(path: string, init: RequestInit): Promise<StripeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(`${STRIPE_PATH}${path}`, {
      ...init,
      // The session cookie IS the authentication here.
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal,
    })

    if (response.status === 204) {
      // Disconnect answers no content. Not an error, and not a status either.
      return { kind: 'ok', status: disconnected() }
    }

    if (!response.ok) {
      return {
        kind: 'refused',
        reason:
          response.status === 401
            ? 'Your session has expired. Sign in again to manage card payments.'
            : 'Stripe could not be reached through your account. Please try again.',
      }
    }

    return { kind: 'ok', status: parse(await response.json()) }
  } catch (error) {
    // Nothing changed. Said plainly, because a merchant who thinks they have
    // half-connected an account will go looking for a mess that is not there.
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

/** Where a stall stands with Stripe today. */
export function fetchStripeStatus(): Promise<StripeResult> {
  return call('/status', { method: 'GET' })
}

/**
 * Begin, or resume, connecting an account.
 *
 * Answers with an onboarding URL to send the merchant to. Stripe hosts that
 * flow, which is the point: identity documents and bank details never touch
 * this app.
 */
export function connectStripe(): Promise<StripeResult> {
  return call('/connect', { method: 'POST', body: JSON.stringify(returnUrls()) })
}

/** Ask the service to re-read Stripe, after the merchant comes back. */
export function refreshStripe(): Promise<StripeResult> {
  const { return_url, refresh_url } = returnUrls()
  return call(
    `/refresh?return_url=${encodeURIComponent(return_url)}&refresh_url=${encodeURIComponent(refresh_url)}`,
    { method: 'GET' },
  )
}

/** Stop taking card payments. */
export function disconnectStripe(): Promise<StripeResult> {
  return call('/disconnect', { method: 'DELETE' })
}

/** The shape of a stall with no account, used where the service returns nothing. */
export function disconnected(): StripeAccountStatus {
  return {
    status: 'not_connected',
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    requirementsDue: [],
  }
}

/**
 * The service's snake_case into ours, defensively.
 *
 * Every boolean defaults to FALSE and every list to empty. A field that arrives
 * missing or malformed must never read as "charges are enabled": that flag
 * decides whether a stall is published as taking cards, and the safe answer to
 * "I do not know" is no.
 */
function parse(body: unknown): StripeAccountStatus {
  const raw = (body ?? {}) as Record<string, unknown>
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined

  return {
    status: str(raw.status) ?? 'unknown',
    stripeAccountId: str(raw.stripe_account_id),
    chargesEnabled: raw.charges_enabled === true,
    payoutsEnabled: raw.payouts_enabled === true,
    detailsSubmitted: raw.details_submitted === true,
    defaultCurrency: str(raw.default_currency),
    requirementsDue: Array.isArray(raw.requirements_due)
      ? raw.requirements_due.filter((r): r is string => typeof r === 'string')
      : [],
    onboardingUrl: str(raw.onboarding_url),
  }
}
