/**
 * "Your subscription was cancelled" (or "un-cancelled"), from the seller to the stall (#407).
 *
 * A licence is a signed voucher that runs to its own expiry, so the wallet's check of it can never
 * learn that the stall cancelled the renewal in Stripe. The subscription service learns it from
 * Stripe's webhook, and tells the wallet with this message: a NIP-17 DM sealed by the licence
 * SELLER's key, published to the relay the wallet already reads its DMs from.
 *
 * It is DISPLAY ONLY. It never grants and never takes away: the plan already paid for runs to its
 * end (#407 §6), and that is decided by the licence alone (ADR 0007). So a forged or lost message
 * can at worst show the wrong word on one screen, never sell or refuse a sale. The wallet accepts it
 * only when the seal is the pinned seller (`VITE_LICENCE_SELLER_PUBKEY`), the same key a licence
 * must name.
 *
 * Shared by `services/subscription` (which writes it) and the wallet (which reads it), so the two
 * cannot drift.
 */

export const SUBSCRIPTION_STATUS_DM_TYPE = 'imani-subscription-status/1'

export interface SubscriptionStatusMessage {
  /** The licence's subscription id (`sub_…`), the thread every renewal shares. */
  subscriptionId: string
  /** `cancelled`: it will not renew. `active`: a cancellation was undone. */
  status: 'cancelled' | 'active'
  /** Unix SECONDS: when a cancelled subscription stops. Absent when unknown or active. */
  endsAt?: number
  /** Unix SECONDS: when the seller learned it. Newest wins on the device. */
  at: number
}

export function subscriptionStatusJson(m: SubscriptionStatusMessage): string {
  return JSON.stringify({
    type: SUBSCRIPTION_STATUS_DM_TYPE,
    subscription_id: m.subscriptionId,
    status: m.status,
    ...(m.endsAt ? { ends_at: m.endsAt } : {}),
    at: m.at,
  })
}

const SUBSCRIPTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** Read one. Null for anything that is not exactly this message. NEVER THROWS. */
export function parseSubscriptionStatus(content: string): SubscriptionStatusMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.type !== SUBSCRIPTION_STATUS_DM_TYPE) return null
  if (typeof r.subscription_id !== 'string' || !SUBSCRIPTION_ID.test(r.subscription_id)) return null
  if (r.status !== 'cancelled' && r.status !== 'active') return null
  if (!isSeconds(r.at)) return null
  if (r.ends_at !== undefined && !isSeconds(r.ends_at)) return null
  return {
    subscriptionId: r.subscription_id,
    status: r.status,
    ...(r.ends_at !== undefined ? { endsAt: r.ends_at as number } : {}),
    at: r.at,
  }
}
