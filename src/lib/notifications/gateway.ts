/**
 * Talking to the gateway about push subscriptions.
 *
 * Thin on purpose. The endpoints already exist on gateway-core
 * (`PushSubscriptionController`) and this file is only the shape of the calls
 * plus the failure policy.
 *
 * ## The failure policy is "never throw"
 *
 * Every function here returns a value rather than raising. A push subscription
 * is a nice-to-have layered on a wallet that already works: if the gateway is
 * unreachable, or VAPID is unconfigured, or the user is on a build older than
 * this endpoint, the wallet must carry on holding money without a stack trace
 * reaching the user. Callers treat `null`/`false` as "not subscribed", which is
 * a state the UI already has to render.
 */

import { signedFetch } from '../nip98'
import type { NotificationPreferences } from './types'
import type { TransportSubscription } from './transport'

const BASE = '/api/v1/push'

/**
 * The gateway's VAPID public key, or null when push cannot work.
 *
 * A 503 here is the NORMAL answer on a stack where `PUSH_VAPID_PUBLIC_KEY` is
 * unset — the controller returns SERVICE_UNAVAILABLE by design. It means "push
 * is off on this deployment", not "something broke", so it is not logged as an
 * error.
 */
export async function fetchVapidKey(): Promise<string | null> {
  try {
    // Deliberately unauthenticated: this endpoint is in the gateway's
    // permit-all list precisely because a client needs the key before it can
    // do anything else.
    const response = await fetch(`${BASE}/vapid-key`)
    if (!response.ok) return null
    const body: unknown = await response.json()
    const key = (body as { publicKey?: unknown } | null)?.publicKey
    return typeof key === 'string' && key.trim() !== '' ? key : null
  } catch {
    return null
  }
}

/** Registers this device. Returns whether the gateway accepted it. */
export async function registerSubscription(
  pubkey: string,
  subscription: TransportSubscription,
): Promise<boolean> {
  try {
    const response = await signedFetch(`${BASE}/subscriptions/${pubkey}`, 'POST', {
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      deviceName: subscription.deviceName,
    })
    if (response.status === 429) {
      // MAX_SUBSCRIPTIONS_PER_USER on the server. Worth its own line: it means
      // the user's old devices are holding the slots, not that anything failed.
      console.warn('[push] too many registered devices; remove one to add this')
    }
    return response.ok
  } catch (e) {
    console.warn('[push] could not register with the gateway:', e)
    return false
  }
}

/**
 * Pushes the per-event switches to the gateway.
 *
 * The server stores three flags per subscription and filters on them when
 * sending, so this is what actually stops an unwanted notification — turning a
 * switch off locally would still let the push arrive and merely hide it.
 *
 * The endpoint hash identifies WHICH device's preferences to change. The server
 * derives it from the endpoint, so it is computed the same way here.
 */
export async function updatePreferences(
  pubkey: string,
  endpoint: string,
  preferences: NotificationPreferences,
): Promise<boolean> {
  try {
    const hash = await hashEndpoint(endpoint)
    const response = await signedFetch(
      `${BASE}/subscriptions/${pubkey}/${hash}/preferences`,
      'PUT',
      {
        notifyVoucherReceived: preferences.voucherReceived,
        notifyVoucherClaimed: preferences.voucherClaimed,
        // The server calls the third flag `expired`; the event it gates is
        // `voucher_expiring`. Mapped here rather than renaming ours, because
        // the wallet's word is the one the user reads.
        notifyVoucherExpired: preferences.voucherExpiring,
      },
    )
    return response.ok
  } catch (e) {
    console.warn('[push] could not update preferences:', e)
    return false
  }
}

/** Deregisters this device, so the gateway stops pushing to it. */
export async function deleteSubscription(pubkey: string, endpoint: string): Promise<boolean> {
  try {
    const hash = await hashEndpoint(endpoint)
    const response = await signedFetch(`${BASE}/subscriptions/${pubkey}/${hash}`, 'DELETE')
    return response.ok
  } catch (e) {
    console.warn('[push] could not remove the subscription:', e)
    return false
  }
}

/**
 * SHA-256 of the endpoint, lowercase hex — the same identifier the server
 * derives, so the two agree on which device a request is about.
 */
async function hashEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
