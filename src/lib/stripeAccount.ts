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
 * ## The "merchant-service is not deployed" note was WRONG
 *
 * This comment used to say the screen would show "could not reach your account
 * service" until `merchant-service` was deployed and routed. That was a wrong
 * diagnosis of a real symptom, and it is left recorded rather than quietly
 * deleted because the reasoning error is the useful part.
 *
 * The evidence was a 403 with an empty body from `/api/v1/merchant/*`, which
 * `src/lib/merchant.ts` had already attributed to the endpoint not existing.
 * All three of those checks now say otherwise:
 *
 * - `imani-deploy` defines `merchant-service` on BOTH stacks (staging, and the
 *   test stack on 28088).
 * - Its nginx routes `^/api/v1/merchants?(/|$)` straight at it, which matches
 *   every path this file calls.
 * - `MerchantStripeController` maps `/api/v1/merchant/stripe` and serves
 *   connect, status, return, refresh and disconnect.
 *
 * The 403 came from the DEV PROXY. There was no rule for this prefix, so it
 * fell into the `/api` catch-all and reached gateway-portal, which refuses an
 * unknown path exactly the way it refuses an unpermitted one. A rule was then
 * added pointing at 8086 — a STAGING publish port, dead on a developer's
 * machine — so the symptom changed from 403 to ECONNREFUSED and the "not
 * deployed" story survived. `src/lib/__tests__/devProxy.test.ts` now pins every
 * rule to a port the local stack actually publishes.
 *
 * The lesson worth keeping: a refusal from a service you did not mean to call
 * is indistinguishable from a refusal by the service you did.
 *
 * ## What happens when it genuinely cannot be reached
 *
 * Unchanged, and still correct: every failure path leaves the stall's published
 * offer untouched, so an unreachable account service means card payments stay
 * off rather than being wrongly advertised.
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
  /**
   * Why {@link onboardingUrl} is absent, when the service DID send one and it
   * was refused.
   *
   * Undefined when there was nothing to refuse. Carried here because the raw
   * value is gone by the time a caller notices the absence, and "no link" and
   * "a link I would not follow" need different words on screen — the first is
   * Stripe having nothing more to ask, the second is a bug or an attack.
   */
  onboardingUrlRejected?: string
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
      if (response.status === 401) {
        return {
          kind: 'refused',
          reason: 'Your session has expired. Sign in again to manage card payments.',
        }
      }
      return { kind: 'refused', reason: await refusalReason(response) }
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

/**
 * What went wrong, in the merchant's words where the service gave us any.
 *
 * Every non-401 used to collapse into "Stripe could not be reached through your
 * account", which was actively misleading the first time this screen was run
 * against a real stack. Stripe Connect was simply switched off — payment-adapter
 * answered 503 CONNECT_DISABLED, merchant-service passed the message through as
 * a 502, and the wallet replaced it with a sentence about reachability. That
 * sent the investigation to the network and the proxy table, when the whole
 * problem was one unset flag in a compose file.
 *
 * So the service's own message wins when it sends one. Two guards on it:
 *
 * - A body that is not JSON, or carries no message, falls back to the generic
 *   sentence rather than showing a fragment of HTML or an empty string.
 * - It is length-capped. This text is rendered in the UI, and an upstream that
 *   returns a stack trace should not become the screen.
 *
 * Deliberately NOT shown for 401: "session expired" is advice the merchant can
 * act on, and no upstream phrasing improves on it.
 */
async function refusalReason(response: Response): Promise<string> {
  const generic = 'Stripe could not be reached through your account. Please try again.'
  try {
    const body: unknown = await response.json()
    const message = (body as { message?: unknown })?.message
    if (typeof message === 'string' && message.trim()) {
      return message.length > 200 ? generic : message
    }
  } catch {
    // Not JSON. The generic sentence is still true, and a parse failure here
    // must never lose the refusal itself.
  }
  return generic
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
    onboardingUrl: stripeUrl(raw.onboarding_url),
    // Only when something was actually sent: an absent field is not a refusal,
    // and reporting one would turn "Stripe is finished with you" into an error.
    onboardingUrlRejected:
      raw.onboarding_url === undefined || raw.onboarding_url === null
        ? undefined
        : (stripeUrlRejection(raw.onboarding_url) ?? undefined),
  }
}

/**
 * An onboarding URL, only if it is one.
 *
 * This value goes into `window.location.href`, so an unchecked string from a
 * response is an open redirect: anything that could shape that response could
 * send a merchant to a page asking for their bank details, arriving from a tap
 * they trusted.
 *
 * Stripe's own hosts, over https, and nothing else. An allowlist rather than a
 * pattern because "looks like Stripe" is exactly what a phisher registers —
 * `stripe.com.example.net` matches a naive contains-check and is not Stripe.
 *
 * ## Rejecting it silently was its own bug
 *
 * A refused URL used to be indistinguishable from no URL at all: both left
 * `onboardingUrl` undefined, and the screen's response to undefined is to do
 * NOTHING. Pressing "Finish setting up" produced no navigation, no error and no
 * console output — the single worst failure a button can have, because there is
 * nothing to search for.
 *
 * It surfaced against stripe-mock, which returns a `*.stripe.me` fixture URL.
 * The rejection was CORRECT; the silence was not. `stripeUrlRejection` now
 * reports the refusal so callers can say what happened, and the tap has a
 * consequence either way.
 */
function stripeUrl(value: unknown): string | undefined {
  return typeof value === 'string' && stripeUrlRejection(value) === null
    ? new URL(value).toString()
    : undefined
}

/**
 * Why an onboarding URL was refused, or null when it is fine.
 *
 * Split out from {@link stripeUrl} so the two can never disagree about what is
 * acceptable — one predicate, two questions. Returning a REASON rather than a
 * boolean is the point: the reader of this message is a developer looking at a
 * button that did nothing, and "not a Stripe address" plus the host they got is
 * the entire diagnosis.
 */
export function stripeUrlRejection(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'Stripe did not send a setup link.'
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'Stripe sent a setup link that is not a valid address.'
  }

  if (url.protocol !== 'https:') {
    return `Refused a setup link that was not https (${url.protocol}//).`
  }

  const host = url.hostname.toLowerCase()
  if (host !== 'stripe.com' && !host.endsWith('.stripe.com')) {
    // Names the host, because that is the fact that identifies the problem —
    // a mock, a typo, or a genuine phishing attempt all look the same without it.
    return `Refused a setup link that was not a Stripe address (${url.hostname}).`
  }

  return null
}
