/**
 * What this device remembers about a card purchase in flight (#267).
 *
 * The return page names the stall, and chooses its words, from here, never from the URL Stripe
 * sends the buyer back to.
 */

/**
 * What a visitor with no wallet sees on the wallet's Buy page (#267 item 2, #410).
 *
 * Was a refusal ("Create a wallet first"). Guests now buy on the gifting site, which delivers by
 * handle or by an emailed Cashlink, so the Buy page points there instead of turning them away.
 */
export const GUEST_BUY_ELSEWHERE = 'No wallet yet? You can buy this voucher by card on the gifting page, for yourself or as a gift.'

/** Session storage key the Buy page writes before leaving for Stripe. */
export const PENDING_PURCHASE_KEY = 'imani:pendingPurchase'

/** A one-off purchase, or the first payment of Monthly payments (an instalment plan). */
export type PurchaseKind = 'one-off' | 'monthly'

const HEX64 = /^[0-9a-f]{64}$/

/** How often an instalment plan pays. Mirrors `PlanInterval` (lib/instalments), kept here so this module imports nothing. */
export type RememberedInterval = 'week' | 'month' | 'year'

export interface RememberedPurchase {
  stallPubkey: string
  kind: PurchaseKind
  /** For a plan: how often it pays, so the return page says "weekly payments" for a weekly one. */
  interval?: RememberedInterval
}

/**
 * The purchase this device was making, or undefined. A record without a valid stall is no
 * record; one without a valid kind is a one-off, which is what every record written before
 * Monthly payments existed was.
 */
export function rememberedPurchase(): RememberedPurchase | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_PURCHASE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { stallPubkey?: unknown; kind?: unknown; interval?: unknown }
    if (typeof parsed.stallPubkey !== 'string' || !HEX64.test(parsed.stallPubkey)) return undefined
    const kind: PurchaseKind = parsed.kind === 'monthly' ? 'monthly' : 'one-off'
    // Only for a plan, and only a known one: a record from before intervals is monthly.
    const interval: RememberedInterval | undefined =
      kind !== 'monthly'
        ? undefined
        : parsed.interval === 'week' || parsed.interval === 'year'
          ? parsed.interval
          : 'month'
    return { stallPubkey: parsed.stallPubkey, kind, ...(interval ? { interval } : {}) }
  } catch {
    return undefined
  }
}

/** The stall this device was buying from, or undefined. */
export function rememberedStall(): string | undefined {
  return rememberedPurchase()?.stallPubkey
}

/** Called by the Buy page just before handing the buyer to Stripe. */
export function rememberPurchase(
  stallPubkey: string,
  kind: PurchaseKind = 'one-off',
  interval?: RememberedInterval,
): void {
  try {
    const record = kind === 'monthly' && interval && interval !== 'month' ? { stallPubkey, kind, interval } : { stallPubkey, kind }
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify(record))
  } catch {
    // Private mode or storage full: the return page just won't name the stall.
  }
}
