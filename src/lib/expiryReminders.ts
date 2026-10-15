import type { VoucherRow } from '@imani/wallet-storage'

import { knownBranding } from './branding'
import { formatFace, displayDecimals } from './format'
import {
  bannerText,
  countdown,
  reminderCandidates,
  reminderId,
  type ReminderCandidate,
} from './couponExpiry'
import { recordNotification } from './notifications/inbox'
import { wantsInApp } from './notifications/wants'

/**
 * The "voucher about to expire" reminder, filed when the wallet is OPEN (#265, option 2).
 *
 * Owner decision 2026-10-15: wallet-only. No server reminder list, no push, no service worker and
 * no request of any kind: everything below reads the coupons already on this device and writes to
 * this device's localStorage. That is also why the Settings switch "Coupons about to expire"
 * defaults ON (`DEFAULT_PREFERENCES.couponExpiring`): nothing leaves the device, so there is no
 * privacy cost to weigh against the reminder, and the people who most need it are the ones who
 * never open Settings.
 *
 * The cost of that decision, stated plainly: a wallet that is never opened is never reminded.
 * gateway-core's `PushNotificationService.notifyVoucherExpiring` is the half that would cover the
 * closed app, and it stays unused until a server-side design is chosen.
 *
 * ## When it runs
 *
 * On unlock, on every change to the stored coupons, and hourly while open (`useExpiryReminders`).
 * Hourly because a threshold is crossed by the clock, not by any event: a wallet left open on the
 * counter must still notice the last day starting.
 *
 * ## Once per coupon per threshold, for ever
 *
 * The bell entry's id is `coupon-expiring:<token_id>:<7d|1d>`, and the inbox already refuses a
 * repeated id. That alone is not enough: the inbox keeps only 50 rows, so a busy stall's bell
 * would drop an old reminder and the next open would file it again. So every id filed is also
 * kept here, per account, and checked first. Bounded too, oldest first, at a size no customer's
 * holdings reach.
 *
 * Per device, not per account: the bell is localStorage and does not sync, so a second device
 * files its own entry. That is the right way round, since each device's bell is read separately.
 */

const FILED_KEY = (pubkey: string) => `imani-wallet:expiry-reminders:${pubkey}`
const BANNER_KEY = (pubkey: string) => `imani-wallet:expiry-banner-dismissed:${pubkey}`
/** Two reminders per coupon, so this covers 500 coupons' worth of history. */
const MAX_FILED = 1000

function readIds(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids.slice(-MAX_FILED)))
  } catch (e) {
    // A private window that refuses writes still gets this session's reminders, once each,
    // through the inbox's own id check.
    console.warn('[expiry] could not persist reminders:', e)
  }
}

export interface ReminderOptions {
  now?: number
  /** Stall names by issuer pubkey. Defaults to the branding this device has already seen. */
  names?: Record<string, string | undefined>
}

function stallName(issuer: string | undefined, names?: ReminderOptions['names']): string | undefined {
  if (!issuer) return undefined
  const key = issuer.toLowerCase()
  if (names) return names[key] ?? names[issuer]
  return knownBranding(key)?.organizationName
}

function faceOf(row: VoucherRow): string {
  return formatFace(row.face_value ?? 0, {
    unit: row.face_unit ?? '',
    decimals: displayDecimals(row.face_unit, row.face_decimals),
  })
}

/** "Your €2.50 voucher from Test Stall expires in 6 days." Never prints a key. */
export function reminderBody(candidate: ReminderCandidate, names?: ReminderOptions['names']): string {
  const name = stallName(candidate.row.issuer_id, names)
  const from = name ? ` from ${name}` : ''
  return `Your ${faceOf(candidate.row)} voucher${from} expires ${countdown(candidate.state.msLeft)}.`
}

/** Is the "Coupons about to expire" switch on for this account? */
export function remindersWanted(pubkey: string): boolean {
  return wantsInApp(pubkey, 'voucher_expiring')
}

/**
 * File the bell entries that are due. Returns how many were filed. Never throws: it runs on every
 * wallet change, and a reminder must never be the thing that breaks a screen.
 */
export function runExpiryReminders(pubkey: string, rows: VoucherRow[], opts: ReminderOptions = {}): number {
  try {
    if (!pubkey || !remindersWanted(pubkey)) return 0
    const now = opts.now ?? Date.now()
    const filed = readIds(FILED_KEY(pubkey))
    const seen = new Set(filed)
    let added = 0
    for (const candidate of reminderCandidates(rows, pubkey, now)) {
      const id = reminderId(candidate.row.token_id, candidate.threshold)
      if (seen.has(id)) continue
      seen.add(id)
      filed.push(id)
      const isNew = recordNotification(pubkey, {
        id,
        type: 'voucher_expiring',
        title: 'Voucher expiring',
        body: reminderBody(candidate, opts.names),
        url: `/coupon/${encodeURIComponent(candidate.row.token_id)}`,
        receivedAt: now,
      })
      if (isNew) added += 1
    }
    writeIds(FILED_KEY(pubkey), filed)
    return added
  } catch (e) {
    console.warn('[expiry] reminder pass failed:', e)
    return 0
  }
}

// ---------------------------------------------------------------------------
// The home banner
// ---------------------------------------------------------------------------

export interface BannerState {
  show: boolean
  count: number
  text: string
}

/** One key per (coupon, threshold): what "a NEW coupon crossed a threshold" is measured against. */
const bannerKeys = (pubkey: string, rows: VoucherRow[], now: number) =>
  reminderCandidates(rows, pubkey, now).map((c) => `${c.row.token_id}:${c.threshold}`)

/**
 * Whether the home banner shows, and what it says.
 *
 * Shown when any held coupon expires within 7 days, unless the user dismissed it and nothing has
 * crossed a threshold since. A dismissal remembers the (coupon, threshold) pairs it saw, so a
 * newly arrived coupon entering the week, or a counted one entering its last day, brings it back,
 * while a coupon merely being spent does not.
 */
export function bannerState(pubkey: string, rows: VoucherRow[], now = Date.now()): BannerState {
  const none = { show: false, count: 0, text: '' }
  try {
    if (!pubkey || !remindersWanted(pubkey)) return none
    const keys = bannerKeys(pubkey, rows, now)
    if (keys.length === 0) return none
    const dismissed = new Set(readIds(BANNER_KEY(pubkey)))
    const fresh = keys.some((k) => !dismissed.has(k))
    return { show: fresh, count: keys.length, text: bannerText(keys.length) }
  } catch {
    return none
  }
}

/** Hide the banner until a new coupon crosses a threshold. */
export function dismissBanner(pubkey: string, rows: VoucherRow[], now = Date.now()): void {
  const merged = new Set([...readIds(BANNER_KEY(pubkey)), ...bannerKeys(pubkey, rows, now)])
  writeIds(BANNER_KEY(pubkey), [...merged])
}
