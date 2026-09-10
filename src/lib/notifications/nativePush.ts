/**
 * Native push: the Capacitor/Android transport.
 *
 * The Android app cannot use Web Push. A Capacitor WebView often exposes
 * `PushManager` and it does not work — the API is present, `subscribe()` may
 * even resolve, and the notifications never arrive. Android delivers through
 * FCM, so this transport gets a registration token from the OS instead.
 *
 * ## Fitting FCM into a Web Push shaped hole
 *
 * The gateway stores `{endpoint, p256dh, auth}` because that is what Web Push
 * needs. FCM has none of those: it has one opaque token, and it encrypts at a
 * different layer, so there are no client keys at all.
 *
 * Rather than add a second table and a second endpoint on day one, the token is
 * carried in the `endpoint` field behind an `fcm:` scheme, and the two key
 * fields are filled with a marker. That is a deliberate trade and it has one
 * real consequence: **the gateway cannot yet deliver to these rows**, because
 * `WebPushService` speaks RFC 8030 and an FCM token is not an RFC 8030
 * endpoint. It will store them and skip them.
 *
 * What that buys is everything else working today — permission, the settings
 * screen, the inbox, enable/disable, the device list — with the server change
 * being purely additive when it lands: recognise the `fcm:` prefix and route
 * those rows to FCM. Nothing here changes when it does.
 *
 * The alternative was to leave native unimplemented until the backend catches
 * up, which would mean the Android app silently has no notifications and no
 * settings screen explaining why. This way the app tells the truth.
 */

import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'

import type { PushTransport, TransportAvailability, TransportSubscription } from './transport'
import type { PermissionState } from './types'

/**
 * Marks a subscription as FCM rather than Web Push.
 *
 * A scheme prefix rather than a separate column: it survives the existing
 * `@Size(max = 500)` validation, it is unambiguous (no Web Push endpoint is
 * ever `fcm:`), and a server-side `startsWith` is all the routing needs.
 */
const FCM_SCHEME = 'fcm:'

/**
 * Filler for the two key fields the gateway requires but FCM does not use.
 *
 * The DTO marks both `@NotBlank`, so they cannot be empty. A readable marker
 * beats a random string: anyone reading the table sees immediately that these
 * are not keys rather than wondering why they fail to decode.
 */
const FCM_KEY_PLACEHOLDER = 'fcm-no-key'

const TOKEN_STORAGE_KEY = 'imani-wallet:fcm-token'

export class NativePushTransport implements PushTransport {
  readonly kind = 'native' as const

  async describe(): Promise<TransportAvailability> {
    if (!Capacitor.isNativePlatform()) {
      return { usable: false, reason: 'Native notifications need the Imani app.' }
    }
    if (!Capacitor.isPluginAvailable('PushNotifications')) {
      return {
        usable: false,
        reason: 'This build of the app cannot receive notifications. Update it and try again.',
      }
    }
    return { usable: true }
  }

  async permission(): Promise<PermissionState> {
    if (!Capacitor.isPluginAvailable('PushNotifications')) return 'unsupported'
    try {
      const status = await PushNotifications.checkPermissions()
      return toPermissionState(status.receive)
    } catch {
      return 'unsupported'
    }
  }

  async requestPermission(): Promise<PermissionState> {
    try {
      const status = await PushNotifications.requestPermissions()
      return toPermissionState(status.receive)
    } catch (e) {
      console.warn('[push] native permission request failed:', e)
      return 'denied'
    }
  }

  /**
   * Register with FCM and wait for the token.
   *
   * `register()` resolves as soon as the request is made, NOT when the token
   * arrives — the token comes back on the `registration` event. So this waits
   * for that event, with a timeout: a device with no Play Services never fires
   * it, and hanging forever would leave the settings screen spinning.
   */
  async subscribe(): Promise<TransportSubscription | null> {
    try {
      const token = await this.awaitToken()
      if (!token) return null

      // Kept so `current()` can answer without re-registering, which would
      // otherwise be the only way to know whether this device is subscribed.
      try {
        localStorage.setItem(TOKEN_STORAGE_KEY, token)
      } catch {
        // Session-only is survivable; the token is re-derivable on next enable.
      }

      return this.toSubscription(token)
    } catch (e) {
      console.warn('[push] native subscribe failed:', e)
      return null
    }
  }

  async unsubscribe(): Promise<void> {
    try {
      // Removes the FCM registration for this app instance.
      await PushNotifications.unregister()
    } catch (e) {
      console.warn('[push] native unregister failed:', e)
    }
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    } catch {
      // Nothing to do: the gateway row is deleted separately.
    }
  }

  async current(): Promise<TransportSubscription | null> {
    if (!Capacitor.isNativePlatform()) return null
    try {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY)
      return token ? this.toSubscription(token) : null
    } catch {
      return null
    }
  }

  private toSubscription(token: string): TransportSubscription {
    return {
      endpoint: FCM_SCHEME + token,
      p256dh: FCM_KEY_PLACEHOLDER,
      auth: FCM_KEY_PLACEHOLDER,
      deviceName: `Imani app on ${Capacitor.getPlatform()}`,
    }
  }

  /** Registers and resolves with the FCM token, or null if it never arrives. */
  private awaitToken(timeoutMs = 10_000): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: string | null) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const timer = setTimeout(() => {
        // A device without Play Services fires neither event. Ten seconds is
        // long enough for a slow network and short enough that the settings
        // screen does not look frozen.
        console.warn('[push] no FCM token arrived; is Google Play Services present?')
        finish(null)
      }, timeoutMs)

      void PushNotifications.addListener('registration', (token) => {
        clearTimeout(timer)
        finish(token.value)
      })

      void PushNotifications.addListener('registrationError', (error) => {
        clearTimeout(timer)
        console.warn('[push] FCM registration refused:', error)
        finish(null)
      })

      void PushNotifications.register().catch((e: unknown) => {
        clearTimeout(timer)
        console.warn('[push] FCM register call failed:', e)
        finish(null)
      })
    })
  }
}

function toPermissionState(value: string): PermissionState {
  if (value === 'granted') return 'granted'
  if (value === 'denied') return 'denied'
  // Capacitor reports 'prompt' and 'prompt-with-rationale'; both mean askable.
  return 'prompt'
}
