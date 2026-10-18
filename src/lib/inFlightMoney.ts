/**
 * Money that is in flight OUTSIDE the coupon rows (second check of #326).
 *
 * Logout's backup check (`confirmBackups`) reads voucher ROWS back from their
 * records. Two ledgers hold value that no row describes, both in localStorage,
 * and logout's `sweepAppStorage()` deletes everything under `imani-wallet:`:
 *
 * - pending sends (pay.ts): a send whose saga outcome is not known yet. Its
 *   source coupon still reads `active` and its record matches, so the backup
 *   check CONFIRMS it, yet the mint has already burnt those proofs and the
 *   change (`keep_token`) is claimed only by `reconcilePendingSends` reading
 *   this ledger. Swept, the change is never claimed and the coupon restores as
 *   spent.
 * - swap intents (swapIntent.ts): the blinding factors of a swap back to sats
 *   interrupted after the mint signed. The only way to rebuild those sats.
 *
 * So while either holds a live entry, logout is refused (owner rule
 * 2026-10-18: never log out until the vouchers are verifiably backed up).
 *
 * No imports on purpose: logout reads this on every attempt, and the keys are
 * defined HERE so pay.ts and swapIntent.ts cannot drift from what logout reads.
 */

export const pendingSendsKey = (pubkey: string) => `imani-wallet:pending-sends:${pubkey}`
export const swapIntentsKey = (pubkey: string) => `imani-wallet:swap-intents:${pubkey}`

/** pay.ts's own window: a send unanswered after this is never going to answer (#127). */
export const PENDING_SEND_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
/** swapIntent.ts's own window: past it the mint can no longer answer for the swap. */
export const SWAP_INTENT_LIFETIME_MS = 60 * 60 * 1000

function liveEntries(key: string, lifetimeMs: number): number {
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    // Storage that cannot be read cannot be shown to be empty.
    return 1
  }
  if (!raw) return 0
  try {
    const parsed: unknown = JSON.parse(raw)
    // pay.ts and swapIntent.ts read a non-array as empty, so nothing could
    // ever recover from it: it is not money this wallet can get back.
    if (!Array.isArray(parsed)) return 0
    const now = Date.now()
    // The same test as their own readers: a numeric `at` inside the window.
    return parsed.filter((entry) => {
      const at = (entry as { at?: unknown } | null)?.at
      return typeof at === 'number' && now - at < lifetimeMs
    }).length
  } catch {
    return 0
  }
}

/** Live (unexpired) entries in each ledger. Never throws. */
export function moneyInFlight(pubkey: string): { sends: number; swaps: number } {
  return {
    sends: liveEntries(pendingSendsKey(pubkey), PENDING_SEND_LIFETIME_MS),
    swaps: liveEntries(swapIntentsKey(pubkey), SWAP_INTENT_LIFETIME_MS),
  }
}
