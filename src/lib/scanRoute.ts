import { merchantStatus } from './merchant'

/**
 * How long a scan waits to learn whether an address is a stall (#280).
 *
 * The answer is the same `merchantStatus` lookup SendPage makes on arrival
 * anyway (cached per session for stalls), so a merchant scan costs no new
 * kind of call. The deadline is for the other case: a relay that accepts and
 * never answers must not hold a friend's address on the scanner. Past it the
 * scan falls back to today's `/send?to=`, which still checks for itself.
 */
export const MERCHANT_LOOKUP_DEADLINE_MS = 1500

/**
 * Where a scanned or typed address goes: a stall opens its profile, anyone
 * else (or an address we could not classify in time) the send flow.
 *
 * Only a definite `merchant` changes the route. `unknown` keeps `/send`, the
 * behaviour a customer already relies on, rather than guessing a shop page.
 */
export async function routeForAddress(
  pubkey: string,
  deadlineMs = MERCHANT_LOOKUP_DEADLINE_MS,
): Promise<string> {
  const status = await Promise.race([
    merchantStatus(pubkey),
    new Promise<'unknown'>((resolve) => setTimeout(() => resolve('unknown'), deadlineMs)),
  ])
  return status === 'merchant' ? `/merchants/${pubkey}` : `/send?to=${pubkey}`
}
