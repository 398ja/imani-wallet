/**
 * A business's verification badge (#418): the public, seller-signed statement of which badge a
 * stall has earned by subscribing, and until when.
 *
 * ## Why an attestation, and why the SELLER signs it
 *
 * A licence reaches its stall privately, by NIP-17 DM, so only the stall's own wallet knows its
 * plan. A customer looking at that stall's avatar has no way to learn it. The licence itself must
 * not be published: it is a voucher, and a copy of it in public is a copy of a credential. So the
 * subscription service, which already signs licences' warrants and the catalog with the seller key
 * (`VITE_LICENCE_SELLER_PUBKEY`), publishes this small event instead, and every viewer checks two
 * things: the event's signature, and that its author IS the pinned seller. A stall cannot award
 * itself a badge, because it cannot sign as the seller.
 *
 * ## What it says, and what it leaves out
 *
 * One addressable event per stall (kind 30078, `d = imani:verification:<stall>`), replaced on every
 * change, listing each badge the stall holds with its own window:
 *
 * ```json
 * { "type": "imani-verification/1", "stall": "<hex>",
 *   "badges": [{ "badge": "bronze", "valid_from": 1767225600, "valid_to": 1769904000 }] }
 * ```
 *
 * A list of windows rather than one answer, so the badge is right at any moment without anyone
 * republishing: an early renewal sits in the list with a future `valid_from`, and a lapsed one
 * simply stops matching when its `valid_to` passes. No grace window applies: the 24 h grace is for
 * selling through an outage, not for wearing a badge past the date it was paid for.
 *
 * Nothing about money: no price, no Stripe id, no subscription id. It says what the badge says.
 *
 * Shared by `services/subscription` (which writes it) and the wallet (which reads it), so the two
 * cannot drift. Pure: no relay, no DOM.
 */

export const VERIFICATION_KIND = 30078
export const VERIFICATION_TYPE = 'imani-verification/1'
const D_PREFIX = 'imani:verification:'

/** The badges, lowest first. Gold is the partnership tier (#418 Q2, deferred), e.g. a hand grant. */
export const BADGES = ['bronze', 'silver', 'gold'] as const
export type Badge = (typeof BADGES)[number]

export function isBadge(value: unknown): value is Badge {
  return typeof value === 'string' && (BADGES as readonly string[]).includes(value)
}

/** The `d` tag of a stall's attestation. Lowercased so a key's case cannot fork it. */
export function verificationD(stallPubkey: string): string {
  return D_PREFIX + stallPubkey.toLowerCase()
}

export interface BadgeWindow {
  badge: Badge
  /** Unix SECONDS: the badge shows from here. */
  validFrom: number
  /** Unix SECONDS: and until (not including) here. */
  validTo: number
}

/** At most this many windows are published, newest-ending first: a stall holds a handful. */
export const MAX_WINDOWS = 24

export function verificationJson(stallPubkey: string, windows: readonly BadgeWindow[]): string {
  const kept = [...windows].sort((a, b) => b.validTo - a.validTo).slice(0, MAX_WINDOWS)
  return JSON.stringify({
    type: VERIFICATION_TYPE,
    stall: stallPubkey.toLowerCase(),
    badges: kept.map((w) => ({ badge: w.badge, valid_from: w.validFrom, valid_to: w.validTo })),
  })
}

const HEX64 = /^[0-9a-f]{64}$/
const isSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * Read one attestation's content, for the stall it must be about. Null for anything that is not
 * exactly this message about exactly this stall. A window that cannot be read is dropped rather
 * than guessed at, so a garbled entry can only cost a badge, never award one. NEVER THROWS.
 */
export function parseVerification(content: string, stallPubkey: string): BadgeWindow[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.type !== VERIFICATION_TYPE) return null
  if (typeof r.stall !== 'string' || !HEX64.test(r.stall) || r.stall !== stallPubkey.toLowerCase()) return null
  if (!Array.isArray(r.badges)) return null
  const windows: BadgeWindow[] = []
  for (const entry of r.badges.slice(0, MAX_WINDOWS)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (!isBadge(e.badge) || !isSeconds(e.valid_from) || !isSeconds(e.valid_to)) continue
    if (e.valid_to <= e.valid_from) continue
    windows.push({ badge: e.badge, validFrom: e.valid_from, validTo: e.valid_to })
  }
  return windows
}

/** The best badge in force at `now` (unix SECONDS), or null. The highest wins (#407 Q3). */
export function badgeAt(windows: readonly BadgeWindow[], now: number): Badge | null {
  let best: Badge | null = null
  for (const w of windows) {
    if (now < w.validFrom || now >= w.validTo) continue
    if (best === null || BADGES.indexOf(w.badge) > BADGES.indexOf(best)) best = w.badge
  }
  return best
}

/**
 * The next instant (unix SECONDS) after `now` at which `badgeAt` can change: a window opening or
 * closing. Undefined when nothing is left to change. Lets a screen left open drop a lapsed badge.
 */
export function nextBadgeChange(windows: readonly BadgeWindow[], now: number): number | undefined {
  let next: number | undefined
  for (const w of windows) {
    for (const t of [w.validFrom, w.validTo]) {
      if (t > now && (next === undefined || t < next)) next = t
    }
  }
  return next
}

/** What a badge is called on screen. */
export const BADGE_LABELS: Record<Badge, string> = {
  bronze: 'Verified business (bronze)',
  silver: 'Verified business (silver)',
  gold: 'Verified business (gold)',
}
