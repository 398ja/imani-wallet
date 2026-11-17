/**
 * Turning a server payload into something a person can read and tap.
 *
 * Shared by both transports and by the service worker, which is why it has no
 * imports beyond types: the SW runs in a worker with no DOM, no React and no
 * access to the app's module graph, so anything it calls has to be this plain.
 *
 * ## Why the wallet re-derives the URL instead of trusting the payload
 *
 * gateway-core sends `data.url = "/voucher/home.html"` on a claim. That is an
 * imani-apps route — a static multi-page app where each screen is its own HTML
 * file. This wallet is a single-page React app with no such path, so honouring
 * the server's URL lands the user on a 404 and the notification looks broken at
 * the only moment it had their attention.
 *
 * Rather than ask the gateway to know about every client's routing, each type
 * maps to a wallet route here. A server URL is used only when it is already
 * wallet-shaped, which lets the gateway deep-link somewhere specific later
 * without another release here.
 */

import {
  isNotificationType,
  type NotificationTypeOrGeneric,
  type PushPayload,
  type RenderableNotification,
} from './types'

/**
 * Where each event takes you.
 *
 * `voucher_received` goes to the coupon list rather than the home screen: the
 * point of the notification is the thing that arrived, and home makes you look
 * for it.
 *
 * `voucher_claimed` goes to `/merchant/transactions`, where the settlement is
 * visible. Note who receives it: gateway-core fires this at
 * `req.senderPubkeyHex()` (PaymentReceiptController.fireSettlementPush), so it
 * reaches the person who SENT a coupon, when the recipient claims it. The path
 * says "merchant" because that is the route's literal name in App.tsx, not
 * because a stall is involved — CONTEXT.md keeps Merchant off customer-facing
 * text, and no string the customer reads here says it.
 */
const ROUTE_FOR_TYPE: Record<NotificationTypeOrGeneric, string> = {
  voucher_received: '/receive',
  voucher_claimed: '/merchant/transactions',
  voucher_expiring: '/',
  cashback_claimed: '/merchant/transactions',
  send_retrying: '/',
  generic: '/',
}

/** Fallback words, used only when the server sent none. */
const FALLBACK_TEXT: Record<NotificationTypeOrGeneric, { title: string; body: string }> = {
  voucher_received: { title: 'Coupon received', body: 'A coupon arrived in your wallet.' },
  voucher_claimed: { title: 'Coupon claimed', body: 'A coupon you sent was claimed.' },
  voucher_expiring: { title: 'Coupon expiring', body: 'A coupon in your wallet expires soon.' },
  cashback_claimed: { title: 'Cashback claimed', body: 'A cashback code you issued was claimed.' },
  send_retrying: {
    title: 'Payment on its way',
    body: "We are retrying a payment you sent. You don't need to do anything.",
  },
  generic: { title: 'Imani', body: 'You have a new notification.' },
}

/** A hex key (or a long prefix of one) or a bech32 npub/nsec. */
const KEY_SHAPED = /\b[0-9a-f]{12,}\b|\bn(pub|sec)1[02-9ac-hj-np-z]{6,}/i

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Accept a server-supplied URL only if it routes inside this wallet.
 *
 * Two failures are being refused at once. The obvious one is the
 * `/voucher/home.html` mismatch described above. The other is that a payload is
 * attacker-influenceable in principle — it is JSON from the network — and an
 * absolute URL taken on trust turns a notification tap into an open redirect.
 *
 * This RESOLVES the URL rather than pattern-matching its first characters,
 * because the obvious check is not safe. An earlier version required a single
 * leading slash and rejected `//`, reasoning that this covered `https://…`,
 * protocol-relative and `javascript:` alike "without needing to parse". It
 * did not: the URL spec treats a backslash as a path separator and strips tab,
 * newline and carriage return from a URL entirely, so
 *
 *     /\evil.example        →  https://evil.example/
 *     /<tab>/evil.example   →  https://evil.example/
 *
 * both begin with exactly one slash and both leave the origin. The only
 * reliable judge of where a URL points is the thing that will navigate to it,
 * so ask the parser and compare origins.
 */
function walletRoute(url: string | undefined): string | undefined {
  if (!url) return undefined
  if (!url.startsWith('/')) return undefined

  // A fixed, arbitrary base: only the ORIGIN COMPARISON matters, and using a
  // constant keeps this identical under test and in a browser.
  const base = 'https://wallet.invalid'
  let resolved: URL
  try {
    resolved = new URL(url, base)
  } catch {
    return undefined
  }

  // The parser has now normalised backslashes and stripped whitespace, so a
  // URL that escapes the wallet shows up here as a different origin.
  if (resolved.origin !== base) return undefined

  // A path ending in .html is an imani-apps page, not a wallet route.
  if (resolved.pathname.endsWith('.html')) return undefined

  // Return the RESOLVED path, not the input: what the caller navigates to must
  // be what was checked, or the check protects nothing.
  return resolved.pathname + resolved.search + resolved.hash
}

/**
 * Make a payload renderable, whatever state it arrived in.
 *
 * Never throws and never returns null. A push that cannot be understood still
 * produces a notification, because the alternative — a silent drop — leaves the
 * user with a phone that buzzed and showed nothing.
 */
export function toRenderable(payload: PushPayload | null | undefined): RenderableNotification {
  const raw = payload ?? {}
  const data = (raw.data ?? {}) as Record<string, unknown>

  // The type can arrive at the top level or inside data; the server sets both.
  const candidate = raw.type ?? readString(data, 'type')
  const type: NotificationTypeOrGeneric = isNotificationType(candidate) ? candidate : 'generic'

  const fallback = FALLBACK_TEXT[type]
  let title = readString({ t: raw.title }, 't') ?? fallback.title
  let body = readString({ b: raw.body }, 'b') ?? fallback.body
  // gateway-core#220: the retry notice must never show a key. If the server's words carry
  // something key-shaped (hex pubkey, npub), the wallet's own plain words are used instead.
  if (type === 'send_retrying' && KEY_SHAPED.test(`${title} ${body}`)) {
    title = fallback.title
    body = fallback.body
  }

  return {
    title,
    body,
    type,
    url: walletRoute(readString(data, 'url')) ?? ROUTE_FOR_TYPE[type],
    // Collapsing on type: a second claim replaces the first rather than
    // stacking two lines that say nearly the same thing.
    tag: `imani-${type}`,
    data,
  }
}
