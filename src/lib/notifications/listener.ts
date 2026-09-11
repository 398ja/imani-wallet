/**
 * Push arrivals reaching the running app.
 *
 * A notification the OS shows is not automatically something the app knows
 * about. Without this, a user who taps a push lands in the wallet and finds an
 * empty bell — the notification they just tapped is nowhere, because only the
 * service worker ever saw it.
 *
 * Two sources, one destination:
 *
 * - **Web**: the service worker posts each push to every open client, and this
 *   listens on `navigator.serviceWorker`.
 * - **Native**: the Capacitor plugin fires `pushNotificationReceived`.
 *
 * Both end at `recordNotification`, which dedupes on id — so an event that
 * arrives by push AND by the drain loop is still one line in the bell.
 */

import { Capacitor } from '@capacitor/core'

import { recordNotification } from './inbox'
import { toRenderable } from './render'
import type { PushPayload } from './types'

let stop: (() => void) | null = null

/**
 * An id for a push that carries none.
 *
 * The gateway's payloads have no notification id, so one is derived from the
 * content and a coarse time bucket. Two identical pushes inside the same minute
 * are almost certainly one event delivered twice (a service worker and the
 * native plugin both reporting it, say), and should collapse. The same content
 * an hour later is a genuinely new event and should not.
 */
function deriveId(payload: PushPayload): string {
  const bucket = Math.floor(Date.now() / 60_000)
  const body = payload.body ?? ''
  const type = payload.type ?? 'generic'
  return `push:${type}:${bucket}:${hash(body)}`
}

/** Small non-cryptographic hash: this only has to distinguish, not to hide. */
function hash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function record(pubkey: string, payload: PushPayload): void {
  const renderable = toRenderable(payload)
  recordNotification(pubkey, {
    id: typeof payload.data?.notificationId === 'string' ? payload.data.notificationId : deriveId(payload),
    type: renderable.type,
    title: renderable.title,
    body: renderable.body,
    url: renderable.url,
  })
}

/**
 * Start listening. Idempotent: a second call replaces the first, so switching
 * account does not leave the previous account's listener recording into the
 * wrong inbox.
 */
export function startPushListener(pubkey: string): void {
  stopPushListener()

  if (Capacitor.isNativePlatform()) {
    stop = startNativeListener(pubkey)
    return
  }

  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; payload?: PushPayload } | null
    if (data?.type !== 'imani-push' || !data.payload) return
    record(pubkey, data.payload)
  }

  navigator.serviceWorker.addEventListener('message', onMessage)
  stop = () => navigator.serviceWorker.removeEventListener('message', onMessage)
}

export function stopPushListener(): void {
  stop?.()
  stop = null
}

function startNativeListener(pubkey: string): () => void {
  // Imported lazily so a web build never pulls the native plugin into its
  // bundle, and so a missing plugin cannot throw at module load.
  const handles: { remove: () => void }[] = []

  void import('@capacitor/push-notifications')
    .then(({ PushNotifications }) =>
      PushNotifications.addListener('pushNotificationReceived', (notification) => {
        record(pubkey, {
          title: notification.title ?? undefined,
          body: notification.body ?? undefined,
          type:
            typeof notification.data?.type === 'string' ? notification.data.type : undefined,
          data: (notification.data ?? {}) as Record<string, unknown>,
        })
      }),
    )
    .then((handle) => handles.push(handle))
    .catch((e: unknown) => console.warn('[push] native listener failed:', e))

  return () => {
    for (const handle of handles) handle.remove()
  }
}
