/**
 * Opening a sister site from the wallet, already signed in (#411, NAP extension 0002).
 *
 * The stall taps "Upgrade my plan" in Settings › Subscription. That tap opens the subscription
 * site in a new tab with `window.open`, so the wallet is the new tab's OPENER. The site asks its
 * opener, over `postMessage`, to sign one NAP login for it; this tab, which holds the unlocked key,
 * answers. No popup, no passphrase, no login page on the site: the session the site needs comes
 * from the wallet the stall is already in.
 *
 * What makes this safe is nap's `mountCrossOriginSigner`, pointed at the tab we opened:
 * - it answers ONLY that window (`event.source`), and only when the browser says the window is on
 *   the site's origin (`event.origin`, which the page cannot choose);
 * - it signs only kind-27235 proofs whose single `u` tag is on that same origin (napSignerPolicy),
 *   so the site cannot obtain a proof for the gateway or for any other site;
 * - the grant lasts minutes, and a wallet lock or logout (in any tab) ends it: nap's signer listens
 *   on the session's own `BroadcastChannel`, and logout reloads this document anyway.
 *
 * The tap is the consent: the stall chose to open this site from their own wallet, and the site can
 * only get a login for itself. So there is no second "Allow?" screen.
 *
 * Headers this relies on, both checked in a real browser by nap's own e2e: the WALLET keeps
 * `Cross-Origin-Opener-Policy: same-origin-allow-popups` (deploy/nginx.conf), and the SITE must be
 * `unsafe-none` (services/subscription/server.ts). Anything stricter on the site severs the opener.
 */
import { CROSS_ORIGIN_PROTOCOL, mountCrossOriginSigner, type CrossOriginSignerHandle } from '@imani/nap-client-web'

import { getSession, getSigner } from './nap'
import { signerPolicy } from './napSignerPolicy'

/** How often the wallet says "ready" to the tab it opened, until that tab connects. */
const READY_EVERY_MS = 400
/** How often to notice the tab was closed. */
const CLOSED_POLL_MS = 1000
/** Stop serving a tab that has not asked for anything in this long. */
const IDLE_LIMIT_MS = 2 * 60 * 60 * 1000

interface Served {
  child: Window
  handle: CrossOriginSignerHandle
  stop: () => void
}

const served = new Set<Served>()

/** The origin of a URL, or null. */
function originOf(url: string): string | null {
  try {
    return new URL(url, window.location.href).origin
  } catch {
    return null
  }
}

/**
 * Open `url` in a tab the wallet can sign in for. Call it from the click handler itself, before
 * any `await`: `window.open` outside a user gesture is blocked.
 *
 * Returns false when the site is not one the wallet signs for, or the browser refused the tab (the
 * caller then falls back to a plain link, and the site shows "open this from your wallet").
 */
export function openSisterSite(url: string, name: string): boolean {
  const origin = originOf(url)
  const policy = signerPolicy()
  if (!origin || !policy[origin]) return false

  const pubkey = getSession()?.getSession()?.pubkey
  const target = new URL(url, window.location.href)
  // Which stall the site should be signed in as. The site drops a session for anyone else.
  if (pubkey) target.searchParams.set('as', pubkey)

  // A named window: a second tap reuses the tab instead of piling up new ones.
  const child = window.open(target.toString(), name)
  if (!child) return false
  serve(child, origin)
  return true
}

function serve(child: Window, origin: string) {
  // Same tab again (a second tap on a named window): serve it once.
  for (const s of served) if (s.child === child) s.stop()

  let lastActivity = Date.now()
  const handle = mountCrossOriginSigner({
    policy: { [origin]: signerPolicy()[origin] },
    signer: getSigner(),
    opener: child,
    target: window,
    isFramed: false,
    // Refuse while the wallet is locked rather than sign with a key that is not there. The site
    // says "unlock your wallet", and asks again.
    ensureUnlocked: async () => {
      lastActivity = Date.now()
      if (getSession()?.isLocked()) throw new Error('locked')
    },
    onConsent: async () => true,
    onGrantsChanged: () => {
      lastActivity = Date.now()
    },
  })

  // "ready" has to reach a page that has not loaded yet, and a page that loads again later (a
  // reload, a session that expired), so it is repeated whenever the tab holds no live grant. Never
  // while it holds one: to a connected page, a second "ready" means the signer restarted, and it
  // drops its grant. A message to a window on about:blank, or anywhere but `origin`, is dropped.
  const ready = setInterval(() => {
    if (child.closed) return
    const now = Math.floor(Date.now() / 1000)
    if (handle.grants().some((g) => g.expiresAt > now)) return
    try {
      child.postMessage({ nap: CROSS_ORIGIN_PROTOCOL, type: 'ready' }, origin)
    } catch {
      /* the tab navigated somewhere we cannot post to; the next tick tries again */
    }
  }, READY_EVERY_MS)

  const closed = setInterval(() => {
    if (child.closed || Date.now() - lastActivity > IDLE_LIMIT_MS) entry.stop()
  }, CLOSED_POLL_MS)

  const entry: Served = {
    child,
    handle,
    stop: () => {
      clearInterval(ready)
      clearInterval(closed)
      handle.close()
      served.delete(entry)
    },
  }
  served.add(entry)
}
