/**
 * Pacing for the limits that are NOT lifted during a run (imani-deploy#405), as shared token
 * buckets in the orchestrator. Pure apart from the clock, which is injectable for tests.
 *
 *   register   gateway-core path-rate-limit: POST /api/v1/nip05 and /api/v1/accounts/register,
 *              10/min per address, no override. Paced to 8/min.
 *   codes      imani-checkout-codes' own per-IP limiter (CHECKOUT_CODES_RL_PER_IP, 60/min
 *              default). A code costs a deposit and a redeem (plus lookups), so codes are paced
 *              to 12/min, well under.
 *   claims     cashback-claim's per-address claim limiter. Paced to 6/min.
 *
 * A 429 on one of these paths is a HARNESS PACING failure, not an app failure, and the report
 * counts it that way (`classify429`).
 */

export type Bucket = { name: string; perMinute: number; take: () => Promise<number> }

export function tokenBucket(
  name: string,
  perMinute: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Bucket {
  const interval = 60_000 / perMinute
  let next = 0
  return {
    name,
    perMinute,
    /** Resolves when a slot is free; returns how long it waited. Slots are handed out in call order. */
    async take() {
      const t = now()
      const slot = Math.max(t, next)
      next = slot + interval
      const wait = slot - t
      if (wait > 0) await sleep(wait)
      return wait
    },
  }
}

export const PACED_LIMITS = {
  register: { perMinute: 8, limit: 'gateway-core path-rate-limit 10/min/address on /api/v1/nip05 and /api/v1/accounts/register (no override)' },
  codes: { perMinute: 12, limit: 'imani-checkout-codes CHECKOUT_CODES_RL_PER_IP (60/min/IP default; a code is several calls)' },
  claims: { perMinute: 6, limit: 'cashback-claim per-address claim limiter (not lifted)' },
} as const

export type PacedLimit = keyof typeof PACED_LIMITS

/** Which un-lifted limiter, if any, a refused request belongs to. */
export function classify429(path: string): PacedLimit | null {
  if (/^\/api\/v1\/(nip05|accounts\/register)\b/.test(path)) return 'register'
  if (/\/v1\/(checkout-codes|code-check)\b/.test(path)) return 'codes'
  if (/\/api\/v1\/(portal\/)?cashback\/(claim|by-code)|\/claim\b/.test(path)) return 'claims'
  return null
}
