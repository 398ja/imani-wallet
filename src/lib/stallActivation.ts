import { COUPON_ISSUE, MERCHANT_D_TAG, MERCHANT_KIND } from './merchant'
import { newestAddressable } from './relay'

/**
 * Getting a brand-new merchant a session that can actually sell (#114).
 *
 * A NAP session's permissions are fixed when `/auth/complete` mints it, and the
 * gateway decides them from the account's kind-30078 `imani:merchant` record.
 * Onboarding publishes that record and logs in within the same second, so the
 * first decision can easily be made before the gateway sees the stall: the
 * session is a customer's, and gateway-core caches that decision for 60 s
 * (MerchantAclService.DECISION_TTL). There is no refresh endpoint and nothing
 * evicts it on publish, so the only way to a merchant session is a fresh
 * handshake once that decision has aged out.
 *
 * Two halves, then:
 *  1. `confirmStallVisible` BEFORE the first login, so in the usual case the
 *     first decision already sees the stall and nothing is cached wrong.
 *  2. `awaitMerchantSession` AFTER it, for when that raced anyway: re-run the
 *     handshake on a backoff that ends past the cache TTL, telling the user
 *     what is happening rather than leaving them on a home screen that says
 *     "Merchant" and a Sell button that bounces.
 */

const PENDING_KEY = 'imani-wallet:stall-activation'

/** Marks this tab as having just registered a merchant. Tab-scoped, like the backup key. */
export function markStallActivation(pubkey: string): void {
  sessionStorage.setItem(PENDING_KEY, pubkey)
}

export function isStallActivationPending(pubkey: string): boolean {
  return sessionStorage.getItem(PENDING_KEY) === pubkey
}

export function clearStallActivation(): void {
  sessionStorage.removeItem(PENDING_KEY)
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Wait until the stall record can be read back, from the relay or the
 * gateway's cache. Bounded: a relay that never echoes it is not a failed
 * signup, the post-login retry below still covers it. Returns whether it was seen.
 */
export async function confirmStallVisible(
  pubkey: string,
  eventCreatedAt: number | undefined,
  {
    read = () => newestAddressable(pubkey, MERCHANT_KIND, MERCHANT_D_TAG),
    wait = sleep,
    delaysMs = [0, 500, 1000, 2000],
  }: {
    read?: () => Promise<{ created_at: number } | null>
    wait?: (ms: number) => Promise<void>
    delaysMs?: number[]
  } = {},
): Promise<boolean> {
  for (const delay of delaysMs) {
    if (delay > 0) await wait(delay)
    const event = await read().catch(() => null)
    if (event && (eventCreatedAt === undefined || event.created_at >= eventCreatedAt)) return true
  }
  return false
}

/**
 * Delays between handshakes, cumulative 3, 10, 25, 45, 65, 80 s. The 65 s step
 * is the one that is guaranteed to land past gateway-core's 60 s decision
 * cache; the earlier ones catch the common case where the first decision was
 * made before the relay write and nothing else pinned it.
 */
export const RELOGIN_DELAYS_MS = [3_000, 7_000, 15_000, 20_000, 20_000, 15_000]

export type ActivationResult = 'merchant' | 'gave-up'

/**
 * Re-authenticate until the session carries `coupon:issue`, or give up.
 *
 * `login` is the same NAP handshake unlock uses (`session.login()`) and must
 * resolve to the fresh session body. A failed attempt is not fatal: the user
 * still has a working customer session, so it is simply retried.
 */
export async function awaitMerchantSession({
  login,
  wait = sleep,
  delaysMs = RELOGIN_DELAYS_MS,
  isCancelled = () => false,
}: {
  login: () => Promise<{ permissions?: readonly string[] }>
  wait?: (ms: number) => Promise<void>
  delaysMs?: number[]
  isCancelled?: () => boolean
}): Promise<ActivationResult | 'cancelled'> {
  for (const delay of delaysMs) {
    await wait(delay)
    if (isCancelled()) return 'cancelled'
    try {
      const body = await login()
      if (isCancelled()) return 'cancelled'
      if (body.permissions?.includes(COUPON_ISSUE)) return 'merchant'
    } catch {
      // Keep the customer session and try again on the next step.
    }
  }
  return 'gave-up'
}
