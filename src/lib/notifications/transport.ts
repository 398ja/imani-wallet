/**
 * The seam between "notify me" and how the bytes actually arrive.
 *
 * Web and native cannot share a delivery mechanism. A browser subscribes to a
 * push service with a VAPID key and gets a `PushSubscription` with an endpoint
 * URL and two crypto keys. Android gets a single opaque FCM registration token
 * and no keys at all, because the transport encrypts at a different layer.
 *
 * Those two have almost nothing in common, so the interface is deliberately
 * small: ask whether it can work here, ask/attain permission, hand back
 * something the gateway can store, and be able to undo it. Everything else —
 * what the events mean, what the user chose, how a payload renders — lives
 * above this line and is written once.
 *
 * ## Why `describe()` exists
 *
 * A transport that cannot work must say why in words a person can act on.
 * "Notifications unavailable" is useless; "Safari needs the app added to your
 * Home Screen first" tells someone what to do. The reason is part of the
 * interface because only the transport knows it.
 */

import type { PermissionState } from './types'

/**
 * What the gateway stores so it can push to this device.
 *
 * Modelled on the Web Push shape because that is what
 * `PushSubscriptionRequest` on gateway-core already accepts: endpoint, p256dh,
 * auth. Native fills the same envelope differently (see native.ts) so the
 * server needs no new endpoint on day one.
 */
export interface TransportSubscription {
  endpoint: string
  p256dh: string
  auth: string
  /** Shown in the settings list so a user can tell devices apart. */
  deviceName: string
}

/** Why a transport cannot be used here, in words worth showing a user. */
export interface TransportAvailability {
  usable: boolean
  /** Non-null when `usable` is false. Written for a person, not a log. */
  reason?: string
}

export interface PushTransport {
  /** Which transport this is, for logs and for the settings screen. */
  readonly kind: 'web' | 'native'

  /** Whether this transport can work in the current runtime, and why not. */
  describe(): Promise<TransportAvailability>

  /** Current OS-level permission, without prompting. */
  permission(): Promise<PermissionState>

  /**
   * Ask the user for permission.
   *
   * Only ever called from a deliberate tap. A prompt the user did not ask for
   * is the fastest route to a permanent denial, which cannot be reversed from
   * inside the app.
   */
  requestPermission(): Promise<PermissionState>

  /**
   * Register with the push service and return what the gateway should store.
   *
   * Returns null when registration could not complete — permission denied, no
   * service worker, no Play Services. Callers treat null as "not subscribed"
   * rather than as an error, because every one of those is a normal state.
   */
  subscribe(vapidPublicKey: string | null): Promise<TransportSubscription | null>

  /** Undo `subscribe` locally. The gateway is told separately. */
  unsubscribe(): Promise<void>

  /** The active registration, if any, without creating one. */
  current(): Promise<TransportSubscription | null>
}
