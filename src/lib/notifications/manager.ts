/**
 * Turning notifications on and off, and remembering the answer.
 *
 * The one place that knows the whole sequence: pick a transport, check it can
 * work, ask permission, register with the push service, tell the gateway, and
 * persist what the user chose. Every step can fail benignly, and each failure
 * has to leave the wallet in a state the settings screen can describe.
 *
 * ## Why the transport is chosen here and nowhere else
 *
 * `pickTransport()` is the only decision point between web and native. Every
 * other module — the renderer, the inbox, the settings screen, the gateway
 * client — is written once against the shared vocabulary and never learns which
 * one it got. That is what stops the native build becoming a second
 * implementation of the same feature.
 */

import { Capacitor } from '@capacitor/core'

import {
  deleteSubscription,
  fetchVapidKey,
  registerSubscription,
  updatePreferences,
} from './gateway'
import { NativePushTransport } from './nativePush'
import { WebPushTransport } from './webPush'
import {
  DEFAULT_PREFERENCES,
  type NotificationPreferences,
  type PermissionState,
} from './types'
import type { PushTransport, TransportAvailability } from './transport'

const PREFS_KEY = (pubkey: string) => `imani-wallet:notification-prefs:${pubkey}`

let transport: PushTransport | null = null

/**
 * The transport for this runtime.
 *
 * Native when running inside Capacitor, web otherwise. Not a feature check: a
 * Capacitor WebView often HAS `PushManager`, and it does not work — the API is
 * present and the notifications never arrive. Asking the platform what it is
 * gives a true answer where feature detection gives a plausible wrong one.
 */
export function pickTransport(): PushTransport {
  if (!transport) {
    transport = Capacitor.isNativePlatform() ? new NativePushTransport() : new WebPushTransport()
  }
  return transport
}

/** Test seam. */
export function _setTransportForTests(next: PushTransport | null): void {
  transport = next
}

export function loadPreferences(pubkey: string): NotificationPreferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY(pubkey))
    if (!raw) return DEFAULT_PREFERENCES
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES
    // Spread over the defaults so a preference added in a later build has a
    // value for a user who stored the older shape.
    return { ...DEFAULT_PREFERENCES, ...(parsed as Partial<NotificationPreferences>) }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function savePreferences(pubkey: string, preferences: NotificationPreferences): void {
  try {
    localStorage.setItem(PREFS_KEY(pubkey), JSON.stringify(preferences))
  } catch (e) {
    console.warn('[push] could not save preferences:', e)
  }
}

export interface NotificationStatus {
  availability: TransportAvailability
  permission: PermissionState
  subscribed: boolean
  preferences: NotificationPreferences
  transport: 'web' | 'native'
}

/** Everything the settings screen needs, without changing anything. */
export async function readStatus(pubkey: string): Promise<NotificationStatus> {
  const active = pickTransport()
  const [availability, permission, current] = await Promise.all([
    active.describe(),
    active.permission(),
    active.current(),
  ])

  return {
    availability,
    permission,
    subscribed: current !== null,
    preferences: loadPreferences(pubkey),
    transport: active.kind,
  }
}

export interface EnableResult {
  ok: boolean
  /** Why it did not work, in words worth showing. Null on success. */
  reason: string | null
  status: NotificationStatus
}

/**
 * Turn notifications on.
 *
 * Only ever called from a deliberate tap: the permission prompt inside must be
 * something the user asked for, because a denial cannot be undone from inside
 * the app.
 */
export async function enableNotifications(pubkey: string): Promise<EnableResult> {
  const active = pickTransport()

  const availability = await active.describe()
  if (!availability.usable) {
    return { ok: false, reason: availability.reason ?? null, status: await readStatus(pubkey) }
  }

  let permission = await active.permission()
  if (permission === 'prompt') permission = await active.requestPermission()
  if (permission !== 'granted') {
    return {
      ok: false,
      // Deliberately says where to fix it. In-app UI cannot re-prompt once
      // denied, and "permission denied" alone leaves the user stuck.
      reason:
        permission === 'denied'
          ? 'Notifications are blocked. Allow them for Imani in your browser or system settings, then try again.'
          : 'Notifications are not available on this device.',
      status: await readStatus(pubkey),
    }
  }

  // Web needs the gateway's VAPID key; native ignores the argument.
  const vapidKey = active.kind === 'web' ? await fetchVapidKey() : null
  if (active.kind === 'web' && !vapidKey) {
    return {
      ok: false,
      reason: 'Notifications are not switched on for this server yet.',
      status: await readStatus(pubkey),
    }
  }

  const subscription = await active.subscribe(vapidKey)
  if (!subscription) {
    return {
      ok: false,
      // The transport knows things this layer cannot infer. A private window is
      // the case that matters: everything above says yes — usable, permission
      // granted, VAPID key in hand — and the browser still refuses, with the
      // thrown error as the only clue. Falling back to the generic sentence
      // when it has nothing better to add.
      reason:
        active.describeLastFailure?.() ??
        'Could not register this device for notifications.',
      status: await readStatus(pubkey),
    }
  }

  const registered = await registerSubscription(pubkey, subscription)
  if (!registered) {
    // Undo the local registration. Leaving it would mean the browser holds a
    // subscription the gateway has never heard of, and the settings screen
    // would show "on" for something that can never deliver.
    await active.unsubscribe()
    return {
      ok: false,
      reason: 'Could not reach the server to finish setting up notifications.',
      status: await readStatus(pubkey),
    }
  }

  const preferences = { ...loadPreferences(pubkey), enabled: true }
  savePreferences(pubkey, preferences)
  // Best-effort: the subscription defaults to all three events on, so a failure
  // here means over-notifying rather than silence.
  await updatePreferences(pubkey, subscription.endpoint, preferences)

  return { ok: true, reason: null, status: await readStatus(pubkey) }
}

/**
 * Re-register an existing subscription with the gateway on startup.
 *
 * A Web Push subscription is not permanent. Browsers rotate the endpoint,
 * expire it, or drop it when storage is cleared, and the `pushsubscriptionchange`
 * event that is supposed to announce that is unreliable and unimplemented in
 * several engines. The failure is silent in the worst way: the settings screen
 * still reads "on" because the local preference says so, the browser still has
 * a subscription, and the gateway is holding an endpoint that now 404s or
 * 410s. Nothing tells the user their phone has stopped ringing.
 *
 * So on every startup, if the user has notifications on and the browser has a
 * live subscription, re-POST it. `POST /subscriptions/{pubkey}` upserts on the
 * endpoint hash, so re-registering an unchanged endpoint touches a row and
 * changes nothing, and a rotated one replaces the stale entry. Cheap, and it
 * is the only thing standing between a rotated endpoint and indefinite silence.
 *
 * Deliberately does NOT prompt, subscribe, or enable anything. It only repairs
 * a registration the user already asked for: `enabled: false` returns straight
 * away, and so does a browser with no current subscription, because creating
 * one would need a permission prompt nobody requested.
 *
 * Never throws. Called from App startup beside the drain loops, where an
 * unhandled rejection would surface as a broken session.
 */
export async function resyncPushSubscription(pubkey: string): Promise<boolean> {
  try {
    if (!loadPreferences(pubkey).enabled) return false

    const current = await pickTransport().current()
    // No live subscription. Either the user never enabled push on this device
    // or the browser dropped it outright; both need a deliberate tap, not a
    // silent prompt from a startup path.
    if (!current) return false

    const registered = await registerSubscription(pubkey, current)
    if (!registered) {
      console.warn('[push] could not resync this device with the gateway')
    }
    return registered
  } catch (e) {
    console.warn('[push] subscription resync failed:', e)
    return false
  }
}

/**
 * Turn notifications off.
 *
 * Deregisters at the gateway BEFORE unsubscribing locally: once the local
 * subscription is gone, its endpoint is gone with it, and the endpoint is how
 * the server identifies which row to delete. The other order orphans a row that
 * keeps receiving pushes nothing will ever show.
 */
export async function disableNotifications(pubkey: string): Promise<NotificationStatus> {
  const active = pickTransport()
  const current = await active.current()

  if (current) await deleteSubscription(pubkey, current.endpoint)
  await active.unsubscribe()

  savePreferences(pubkey, { ...loadPreferences(pubkey), enabled: false })
  return readStatus(pubkey)
}

/**
 * Change which events notify, while staying subscribed.
 *
 * Pushed to the gateway rather than filtered locally: the server holds the
 * flags and filters before sending, so an off switch here stops the push being
 * sent at all rather than hiding one that already arrived.
 */
export async function setPreferences(
  pubkey: string,
  preferences: NotificationPreferences,
): Promise<NotificationStatus> {
  savePreferences(pubkey, preferences)

  const current = await pickTransport().current()
  if (current) await updatePreferences(pubkey, current.endpoint, preferences)

  return readStatus(pubkey)
}
