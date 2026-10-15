/**
 * What this device remembers about a card purchase in flight (#267).
 *
 * The return page names the stall from here, never from the URL Stripe sends
 * the buyer back to.
 */

/** What a visitor with no wallet sees instead of a card form (#267 item 2). */
export const GUEST_REFUSED = 'Create a wallet first to buy a voucher by card'

/** Session storage key the Buy page writes before leaving for Stripe. */
export const PENDING_PURCHASE_KEY = 'imani:pendingPurchase'

const HEX64 = /^[0-9a-f]{64}$/

/** The stall this device was buying from, or undefined. */
export function rememberedStall(): string | undefined {
  try {
    const raw = sessionStorage.getItem(PENDING_PURCHASE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { stallPubkey?: unknown }
    return typeof parsed.stallPubkey === 'string' && HEX64.test(parsed.stallPubkey)
      ? parsed.stallPubkey
      : undefined
  } catch {
    return undefined
  }
}

/** Called by the Buy page just before handing the buyer to Stripe. */
export function rememberPurchase(stallPubkey: string): void {
  try {
    sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({ stallPubkey }))
  } catch {
    // Private mode or storage full: the return page just won't name the stall.
  }
}
