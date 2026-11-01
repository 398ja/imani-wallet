/**
 * Subscriptions the seller has ended, as the server said so (review of imani-wallet#226, W-1).
 *
 * A seller revokes by `(subscription_id, seller)` and the revocation is permanent: gateway-customer
 * then answers this account's report of any licence of that subscription `422 LICENCE_REVOKED`.
 * `licenceReport` used to remember only that the voucher was refused, so this device went on
 * saying "active", listing the paid tills as licensed and letting the owner enrol another, each of
 * which then sold 402.
 *
 * The verdict is kept here per account, under the server's own key, so the local check
 * (`licenceStatus`) stops granting that subscription, including a renewal minted under the same id
 * afterwards, which the server refuses too. Only a `LICENCE_REVOKED` code is a revocation: another
 * 422 (a stranger's licence, a wrong key) stays a refusal of that voucher only.
 *
 * It only ever takes away. Nothing here can make a licence grant, so a corrupted or cleared record
 * at worst shows "active" until the next report, which is the state before this existed: the server
 * remains the boundary (ADR 0007), and the paid tills are refused there regardless.
 */

const KEY_PREFIX = 'imani.licence.revoked.'

/** A backstop: one stall holds a handful of subscriptions in its life, not thousands. */
const MAX_REVOKED = 256

export interface SellerRevocation {
  subscriptionId: string
  /** The seller's stall key, lowercase hex: a revocation is scoped to the seller that made it. */
  seller: string
  /** Unix SECONDS, when this device learned it. */
  at: number
}

function keyFor(pubkey: string): string {
  return `${KEY_PREFIX}${pubkey.trim().toLowerCase()}`
}

function norm(hex: string | undefined): string {
  return (hex ?? '').trim().toLowerCase()
}

export function readRevocations(pubkey: string): SellerRevocation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(pubkey)) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (r): r is SellerRevocation =>
        !!r &&
        typeof (r as SellerRevocation).subscriptionId === 'string' &&
        typeof (r as SellerRevocation).seller === 'string' &&
        typeof (r as SellerRevocation).at === 'number',
    )
  } catch {
    return []
  }
}

/** Is `subscriptionId`, sold by `seller`, revoked for this account? */
export function isRevokedBySeller(pubkey: string, subscriptionId: string | undefined, seller: string | undefined): boolean {
  if (!subscriptionId || !seller) return false
  const s = norm(seller)
  return readRevocations(pubkey).some((r) => r.subscriptionId === subscriptionId && norm(r.seller) === s)
}

/** Remember that the server answered LICENCE_REVOKED for this subscription of this seller. */
export function rememberRevocation(pubkey: string, subscriptionId: string, seller: string, at: number): void {
  if (!subscriptionId || !seller) return
  try {
    const s = norm(seller)
    const kept = readRevocations(pubkey).filter((r) => !(r.subscriptionId === subscriptionId && norm(r.seller) === s))
    kept.push({ subscriptionId, seller: s, at })
    localStorage.setItem(keyFor(pubkey), JSON.stringify(kept.slice(-MAX_REVOKED)))
  } catch {
    // Not remembered: the next report is refused again and tries again. The server still refuses.
  }
}

/** Forget every revocation this device learned for the account. For tests, and for a wipe. */
export function forgetRevocations(pubkey: string): void {
  try {
    localStorage.removeItem(keyFor(pubkey))
  } catch {
    // Nothing to clear.
  }
}
