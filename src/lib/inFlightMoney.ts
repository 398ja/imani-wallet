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
/** #552: atomic bundles whose outcome is not known yet (pay.ts). Never expire: the next run finishes each. */
export const pendingBundlesKey = (pubkey: string) => `imani-wallet:pending-bundles:${pubkey}`
export const swapIntentsKey = (pubkey: string) => `imani-wallet:swap-intents:${pubkey}`
/**
 * #179: the Idempotency-Key of a send whose request went out and got no answer (sendIntent.ts).
 * The send may have happened, so it counts as a send in flight until the retry learns the answer.
 */
export const sendIntentsKey = (pubkey: string) => `imani-wallet:send-intents:${pubkey}`
/**
 * #295 phase 4: a Cashlink claim part way (the recipient's random blinding factors, written before
 * the burn), and the sender's Cashlinks whose value is moving (being locked to the link, or off the
 * link and not yet back as a voucher). Neither expires: the value does not, and the next run of
 * this wallet finishes each one and clears it.
 */
export const cashlinkClaimsKey = (pubkey: string) => `imani-wallet:cashlink-claims:${pubkey}`
export const cashlinkMovingKey = (pubkey: string) => `imani-wallet:cashlink-moving:${pubkey}`
/** #402: the customer's checkout codes; one not yet finished is value only its record can bring back. */
export const checkoutCodesLedgerKey = (pubkey: string) => `imani-wallet:checkout-codes:${pubkey}`
/** #402: a voucher split part way (written before its burn). Never expires; the next run finishes it. */
export const voucherSplitsKey = (pubkey: string) => `imani-wallet:voucher-splits:${pubkey}`
/** #543: a Cashlink being made on the direct path (cashlinkIntents.ts). Never expires; the next run finishes it. */
export const cashlinkIntentsKey = (pubkey: string) => `imani-wallet:cashlink-intents:${pubkey}`

/** pay.ts's own window: a send unanswered after this is never going to answer (#127). */
export const PENDING_SEND_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
/** sendIntent.ts's own window: gateway-core keeps a send's key for longer than this. */
export const SEND_INTENT_LIFETIME_MS = 24 * 60 * 60 * 1000
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

/** Every entry, however old. Storage that cannot be read, or holds no list, counts as one. */
function allEntries(key: string): number {
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return 1
  }
  if (!raw) return 0
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 1
  } catch {
    // Unreadable is not empty: the value it describes may be real.
    return 1
  }
}

/** Checkout codes not yet finished (`done`). Unreadable storage counts as one. */
function outstandingCodes(key: string): number {
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return 1
  }
  if (!raw) return 0
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((r) => !(r as { done?: unknown } | null)?.done).length : 1
  } catch {
    return 1
  }
}

/**
 * #543: direct Cashlink intents whose value is still moving: a part not yet locked (or kept), or a
 * locked wrap not yet on its link. One kept only to retry a refund deposit is not: its value is
 * locked on the link and comes back at `x` either way. Unreadable storage counts as one.
 */
function movingIntents(key: string): number {
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return 1
  }
  if (!raw) return 0
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return 1
    type Part = { state?: unknown; wraps?: unknown; published?: unknown; sourceSettled?: unknown }
    const moving = (p: Part) => {
      if (p.state === 'new' || p.state === 'arming') return true
      if ((p.state === 'kept' || p.state === 'locked') && p.sourceSettled !== true) return true
      const wraps = Array.isArray(p.wraps) ? p.wraps : []
      const published = Array.isArray(p.published) ? p.published : []
      return p.state === 'locked' && wraps.some((w) => !published.includes(w))
    }
    return parsed.filter((i) => !Array.isArray((i as { parts?: unknown })?.parts) || ((i as { parts: Part[] }).parts).some(moving)).length
  } catch {
    return 1
  }
}

/** Live (unexpired) entries in each ledger. Never throws. */
export function moneyInFlight(pubkey: string): { sends: number; swaps: number; cashlinks: number; codes: number; unanswered: number } {
  return {
    sends:
      liveEntries(pendingSendsKey(pubkey), PENDING_SEND_LIFETIME_MS) +
      liveEntries(sendIntentsKey(pubkey), SEND_INTENT_LIFETIME_MS) +
      allEntries(pendingBundlesKey(pubkey)),
    swaps: liveEntries(swapIntentsKey(pubkey), SWAP_INTENT_LIFETIME_MS),
    cashlinks: allEntries(cashlinkClaimsKey(pubkey)) + allEntries(cashlinkMovingKey(pubkey)) + allEntries(voucherSplitsKey(pubkey)) + movingIntents(cashlinkIntentsKey(pubkey)),
    // #557: outstanding checkout codes, on their own. Logout lets one through once its relay backup
    // is read back (checkoutCodeBackup.ts); anything else that reads this still counts it as value.
    codes: outstandingCodes(checkoutCodesLedgerKey(pubkey)),
    // #389: of `sends`, those whose request got no answer at all and that the gateway's history
    // could not place yet. Counted in `sends` too; told apart so logout can say what it waits for.
    unanswered: liveEntries(sendIntentsKey(pubkey), SEND_INTENT_LIFETIME_MS),
  }
}
