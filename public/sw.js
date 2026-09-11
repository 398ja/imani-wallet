/**
 * The wallet's service worker.
 *
 * Its ONLY job is notifications: receive a push, show it, and route the tap.
 * It deliberately does not cache anything — no offline shell, no asset
 * precaching, no fetch handler at all.
 *
 * That restraint is the point. A caching service worker on a wallet is a
 * liability: it serves a stale build to someone holding money, and the failure
 * shows up as balances and coupon states that disagree with the gateway. The
 * value here is being able to notify a user whose app is closed, and that needs
 * no cache whatsoever.
 *
 * It is plain JavaScript in `public/` rather than TypeScript in `src/` because
 * it must be served from the ORIGIN ROOT to control the whole scope. A worker
 * at `/assets/sw-a1b2c3.js` can only control `/assets/`, and Vite hashes and
 * relocates everything it compiles. Keeping it here also means its URL is
 * stable across deploys, which is what lets an existing registration update
 * itself rather than orphan.
 *
 * The logic it shares with the app (deciding what a payload means, refusing a
 * URL that is not wallet-shaped) is duplicated below rather than imported, for
 * the same reason: a worker cannot import from the app's module graph. It is
 * kept deliberately small so the duplication stays honest, and the app-side
 * copy in `src/lib/notifications/render.ts` carries the reasoning.
 */

/* eslint-env serviceworker */

const ROUTE_FOR_TYPE = {
  voucher_received: '/receive',
  voucher_claimed: '/merchant/transactions',
  voucher_expiring: '/',
  generic: '/',
}

const FALLBACK_TEXT = {
  voucher_received: { title: 'Coupon received', body: 'A coupon arrived in your wallet.' },
  voucher_claimed: { title: 'Coupon claimed', body: 'A coupon you sent was claimed.' },
  voucher_expiring: { title: 'Coupon expiring', body: 'A coupon in your wallet expires soon.' },
  generic: { title: 'Imani', body: 'You have a new notification.' },
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Only a same-origin, wallet-shaped path is honoured. See render.ts: the
 * gateway sends `/voucher/home.html`, which does not exist here, and an
 * absolute URL taken on trust turns a tap into an open redirect.
 *
 * RESOLVE rather than pattern-match. Requiring one leading slash and rejecting
 * `//` looks sufficient and is not: the URL spec treats a backslash as a path
 * separator and strips tab/newline/CR, so `/\evil.example` and
 * `/<tab>/evil.example` each begin with a single slash and each resolve to
 * `https://evil.example/`. This worker is the copy that actually calls
 * `openWindow`, so the hole was directly exploitable here.
 */
function walletRoute(url) {
  if (!url || !url.startsWith('/')) return undefined
  const base = 'https://wallet.invalid'
  let resolved
  try {
    resolved = new URL(url, base)
  } catch {
    return undefined
  }
  if (resolved.origin !== base) return undefined
  if (resolved.pathname.endsWith('.html')) return undefined
  // The resolved path, not the input: navigate to what was actually checked.
  return resolved.pathname + resolved.search + resolved.hash
}

/**
 * An explicit allow-list, NOT `ROUTE_FOR_TYPE[candidate]`.
 *
 * A truthiness lookup finds inherited Object.prototype members, so a payload
 * carrying `type: "constructor"` counted as a known type and
 * `FALLBACK_TEXT["constructor"]` resolved to a FUNCTION — whose `.title` is
 * undefined, producing a notification with no title. That is the silent drop
 * this worker exists to prevent, reached from a string on the network.
 *
 * Mirrors `isNotificationType` in render.ts, which was always an allow-list.
 */
const KNOWN_TYPES = ['voucher_received', 'voucher_claimed', 'voucher_expiring']

function toRenderable(payload) {
  const raw = payload || {}
  const data = raw.data || {}
  const candidate = raw.type || data.type
  const type = KNOWN_TYPES.indexOf(candidate) !== -1 ? candidate : 'generic'
  const fallback = FALLBACK_TEXT[type]

  return {
    title: text(raw.title) || fallback.title,
    body: text(raw.body) || fallback.body,
    type,
    url: walletRoute(text(data.url)) || ROUTE_FOR_TYPE[type],
    tag: 'imani-' + type,
    data,
  }
}

/**
 * Take over immediately rather than waiting for every old tab to close.
 *
 * A worker that waits leaves a user who just enabled notifications with no
 * worker actually running, so the first push goes nowhere and the feature
 * looks broken. There is no cache to migrate, so there is nothing for the
 * usual caution to protect.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let payload = null
  if (event.data) {
    try {
      payload = event.data.json()
    } catch {
      // A non-JSON push still has to render: the phone already buzzed.
      payload = { body: event.data.text() }
    }
  }

  const notification = toRenderable(payload)

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(notification.title, {
        body: notification.body,
        icon: '/imani.png',
        badge: '/imani.png',
        // Same tag collapses a burst onto one line rather than stacking near
        // duplicates.
        tag: notification.tag,
        renotify: true,
        // The server's `data` is spread FIRST so the sanitised url and type win.
        // The other way round, a payload carrying its own `data.url` overwrites
        // the checked value and the notificationclick handler below would open
        // whatever the push asked for — the open redirect the check exists to
        // prevent. (Caught by serviceWorker.test.ts.)
        data: { ...notification.data, url: notification.url, type: notification.type },
        timestamp: Date.now(),
      }),
      // Tell any open wallet, so the bell fills up without waiting for a tap.
      // Without this a user who dismisses the OS notification has no record of
      // it anywhere, and one who taps it lands on an empty bell.
      notifyClients(payload),
    ]),
  )
})

/** Posts the raw payload to every open wallet window. */
async function notifyClients(payload) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) {
    // Best-effort: a client that has gone away simply misses it, and the drain
    // loop remains the other path into the inbox.
    try {
      client.postMessage({ type: 'imani-push', payload })
    } catch {
      /* ignore */
    }
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = walletRoute(event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        // Includes tabs this worker has not yet claimed — otherwise a tap
        // opens a second window alongside the wallet the user already has.
        includeUncontrolled: true,
      })

      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue
        // Focus the wallet that is already open and route it, rather than
        // opening a duplicate. `navigate` can reject (a cross-origin or
        // discarded client), and losing the focus is better than losing the tap.
        await client.focus()
        try {
          await client.navigate(target)
        } catch {
          // Focused but not navigated: the user is at least in the wallet.
        }
        return
      }

      await self.clients.openWindow(target)
    })(),
  )
})
