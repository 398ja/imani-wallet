/**
 * Web Push: the browser and installed-PWA transport.
 *
 * Subscribes through the service worker registration using the gateway's VAPID
 * public key, and hands back the endpoint plus the two keys the server needs to
 * encrypt to this device.
 *
 * ## Why so much of this is feature detection
 *
 * Push is the least uniformly supported API the wallet touches. Firefox in a
 * private window has `Notification` but no `PushManager`. iOS Safari has both,
 * but only once the site is installed to the Home Screen — in a normal tab
 * `subscribe()` rejects with a message no user could act on. An Android WebView
 * often has the API present and permanently non-functional.
 *
 * Every one of those is a NORMAL state, not an error, and each needs different
 * words. So `describe()` distinguishes them and the caller shows the reason
 * rather than a generic failure.
 */

import type { PermissionState } from './types'
import type { PushTransport, TransportAvailability, TransportSubscription } from './transport'

const SERVICE_WORKER_PATH = '/sw.js'

/**
 * VAPID keys arrive base64url-encoded and `applicationServerKey` wants raw
 * bytes. Padding is re-added because base64url drops it and `atob` requires it.
 *
 * The buffer is allocated explicitly rather than letting `new Uint8Array(n)`
 * infer it: TypeScript 5.7 types that as `Uint8Array<ArrayBufferLike>`, which
 * could be a `SharedArrayBuffer`, and `BufferSource` will not accept one.
 */
function urlBase64ToUint8Array(base64UrlString: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64UrlString.length % 4)) % 4)
  const base64 = (base64UrlString + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}

/** ArrayBuffer to base64url, for the p256dh/auth keys the gateway stores. */
function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A name a human can tell apart in a device list.
 *
 * Deliberately coarse. The user agent is the only signal available and parsing
 * it precisely is a losing game; "Chrome on Android" is enough to recognise
 * your own phone, which is all this is for.
 */
function describeDevice(userAgent: string): string {
  const ua = userAgent.toLowerCase()
  const platform = ua.includes('android')
    ? 'Android'
    : /iphone|ipad|ipod/.test(ua)
      ? 'iOS'
      : ua.includes('mac')
        ? 'Mac'
        : ua.includes('windows')
          ? 'Windows'
          : ua.includes('linux')
            ? 'Linux'
            : 'this device'

  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('chrome') && !ua.includes('chromium')
      ? 'Chrome'
      : ua.includes('firefox')
        ? 'Firefox'
        : ua.includes('safari')
          ? 'Safari'
          : 'Browser'

  return `${browser} on ${platform}`
}

/**
 * Whether an iOS browser is running as an installed app.
 *
 * iOS grants Push only to a Home Screen install. `standalone` is a non-standard
 * Safari property, hence the cast; the display-mode query covers everything
 * else.
 */
function isStandalone(): boolean {
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone
  if (iosStandalone === true) return true
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(display-mode: standalone)').matches
    : false
}

export class WebPushTransport implements PushTransport {
  readonly kind = 'web' as const

  async describe(): Promise<TransportAvailability> {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return { usable: false, reason: 'Notifications need a browser.' }
    }
    if (!('serviceWorker' in navigator)) {
      return { usable: false, reason: 'This browser has no service worker support.' }
    }
    if (!('PushManager' in window)) {
      // Firefox private windows land here.
      return { usable: false, reason: 'This browser cannot receive push notifications.' }
    }
    if (!('Notification' in window)) {
      return { usable: false, reason: 'This browser cannot show notifications.' }
    }
    // Push needs a secure context. localhost counts, which is why this is not
    // a plain https check — it would break local development.
    if (!window.isSecureContext) {
      return { usable: false, reason: 'Notifications need a secure (HTTPS) connection.' }
    }
    if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !isStandalone()) {
      return {
        usable: false,
        reason: 'On iPhone and iPad, add Imani to your Home Screen first, then turn this on.',
      }
    }
    return { usable: true }
  }

  async permission(): Promise<PermissionState> {
    if (typeof Notification === 'undefined') return 'unsupported'
    const current = Notification.permission
    return current === 'default' ? 'prompt' : current
  }

  async requestPermission(): Promise<PermissionState> {
    if (typeof Notification === 'undefined') return 'unsupported'
    const result = await Notification.requestPermission()
    return result === 'default' ? 'prompt' : result
  }

  /** Registers the worker, or reuses the existing registration. */
  private async registration(): Promise<ServiceWorkerRegistration | null> {
    try {
      const existing = await navigator.serviceWorker.getRegistration()
      if (existing) return existing
      return await navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: '/' })
    } catch (e) {
      console.warn('[push] service worker registration failed:', e)
      return null
    }
  }

  async subscribe(vapidPublicKey: string | null): Promise<TransportSubscription | null> {
    if (!vapidPublicKey) {
      // The gateway answers 503 on /vapid-key when keys are unconfigured.
      // Subscribing without one silently produces a subscription no server can
      // ever push to, so refuse rather than look successful.
      console.warn('[push] no VAPID key from gateway; not subscribing')
      return null
    }
    const registration = await this.registration()
    if (!registration) return null

    try {
      // An existing subscription is reused rather than replaced: its endpoint
      // is already stored server-side, and churning it orphans that row.
      const existing = await registration.pushManager.getSubscription()
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          // Required by every browser that implements Push: a subscription that
          // can deliver silently is not permitted.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }))

      return this.toTransportSubscription(subscription)
    } catch (e) {
      console.warn('[push] subscribe failed:', e)
      return null
    }
  }

  async unsubscribe(): Promise<void> {
    const registration = await navigator.serviceWorker?.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  }

  async current(): Promise<TransportSubscription | null> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    return subscription ? this.toTransportSubscription(subscription) : null
  }

  private toTransportSubscription(subscription: PushSubscription): TransportSubscription | null {
    const p256dh = arrayBufferToBase64Url(subscription.getKey('p256dh'))
    const auth = arrayBufferToBase64Url(subscription.getKey('auth'))
    if (!p256dh || !auth) {
      // The gateway rejects blank keys (@NotBlank), and a subscription without
      // them cannot be encrypted to anyway.
      console.warn('[push] subscription is missing its encryption keys')
      return null
    }
    return {
      endpoint: subscription.endpoint,
      p256dh,
      auth,
      deviceName: describeDevice(navigator.userAgent),
    }
  }
}
