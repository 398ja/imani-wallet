import type { VoucherRow } from '@imani/wallet-storage'
import { readExpiry } from '@imani/wallet-core'

import { formatDate, toEpochMs } from './format'
import { issuerKey, spendable } from './merchants'
import { tokenProofs } from './voucherToken'
import { asOneVoucher, groupByVoucher } from './voucherCount'
import { spendingKeys, xOnly } from './witness'

/**
 * How close a coupon is to running out, as one pure function of the row and the clock (#265).
 *
 * Everything a screen says about a coupon's expiry comes from here: the list, deck and merchant
 * page badges, the detail page's countdown, the bell entries and the home banner. Doing it in one
 * place means a coupon always reads the same way on every screen, and a test can pin any
 * boundary by passing a clock.
 *
 * ## The thresholds
 *
 * 7 days and 1 day, the same window the licence notice uses (`expiryNotice.ts`,
 * `NOTICE_WINDOW_DAYS`) and merchants' "Expiring soon" uses (`/merchant/expiring`). A week is
 * enough warning to plan a trip to the stall, and the last day is the final nudge.
 *
 * ## Rounding DOWN
 *
 * "Expires in 1 day" must never appear when 20 hours are left: overstating the time left is the
 * mistake a customer pays for. So days are floored, and under a day the label switches to hours.
 *
 * ## Derived, never stored
 *
 * Nothing here writes. The one stored fact in the feature is "this reminder was already filed",
 * which lives in `expiryReminders.ts`.
 */

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS

/** The amber window: inside this, a coupon carries a badge and qualifies for the 7-day reminder. */
export const SOON_MS = 7 * DAY_MS
/** The red window, and the 1-day reminder. */
export const URGENT_MS = DAY_MS

/** `calm` = beyond 7 days, no badge. `soon` = amber. `urgent` = red. */
export type ExpiryTone = 'calm' | 'soon' | 'urgent'

export type ExpiryState =
  | { kind: 'none' }
  | {
      kind: 'expired'
      expiresAt: number
      /** The absolute date, locale-formatted. */
      dateText: string
    }
  | {
      kind: 'live'
      expiresAt: number
      msLeft: number
      tone: ExpiryTone
      /** "Expires in 3 days". Always shown as TEXT, so colour is never the only signal. */
      label: string
      /** The label plus the absolute date, for screen readers and tooltips. */
      ariaLabel: string
      dateText: string
    }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "in 3 days", "in 5 hours", "in under an hour". Floored, see the module note. */
export function countdown(msLeft: number): string {
  if (msLeft >= DAY_MS) return `in ${plural(Math.floor(msLeft / DAY_MS), 'day')}`
  if (msLeft >= HOUR_MS) return `in ${plural(Math.floor(msLeft / HOUR_MS), 'hour')}`
  return 'in under an hour'
}

/** "Expires in 3 days". */
export function expiryLabel(msLeft: number): string {
  return `Expires ${countdown(msLeft)}`
}

/**
 * What a coupon's expiry says at `now`.
 *
 * An expiry nobody can read reads as `none` here, exactly as `isLive` in merchants.ts treats it,
 * so a badge never disagrees with whether the coupon is in the list at all.
 */
export function expiryState(row: Pick<VoucherRow, 'expires_at'>, now = Date.now()): ExpiryState {
  const expiresAt = toEpochMs(row.expires_at)
  if (expiresAt === undefined) return { kind: 'none' }
  const dateText = formatDate(expiresAt)
  const msLeft = expiresAt - now
  if (msLeft <= 0) return { kind: 'expired', expiresAt, dateText }
  const tone: ExpiryTone = msLeft <= URGENT_MS ? 'urgent' : msLeft <= SOON_MS ? 'soon' : 'calm'
  const label = expiryLabel(msLeft)
  return { kind: 'live', expiresAt, msLeft, tone, label, ariaLabel: `${label}, on ${dateText}`, dateText }
}

/** Whether a coupon's expiry deserves a badge: inside the 7-day window and not yet past. */
export function isExpiringSoon(state: ExpiryState): state is Extract<ExpiryState, { kind: 'live' }> {
  return state.kind === 'live' && state.tone !== 'calm'
}

// ---------------------------------------------------------------------------
// Who a reminder is for
// ---------------------------------------------------------------------------

const lockCache = new Map<string, boolean>()

/**
 * Is this coupon locked (P2PK) to a key that is not mine?
 *
 * Such a coupon sits in the wallet, but this wallet cannot spend it, so telling its holder to
 * "use it before" would be advice they cannot follow. Read from the token's own proof secrets.
 * A token that cannot be parsed is NOT excluded: an unreadable token is somebody else's error to
 * report, and silence here would hide money.
 */
export function lockedToSomeoneElse(row: Pick<VoucherRow, 'token' | 'token_id'>, me: string): boolean {
  const key = `${row.token_id}:${me}`
  const cached = lockCache.get(key)
  if (cached !== undefined) return cached
  let answer = false
  try {
    const mine = xOnly(me.toLowerCase())
    for (const proof of tokenProofs(row.token)) {
      const keys = spendingKeys(proof.secret).map((k) => xOnly(k.toLowerCase()))
      if (keys.length > 0 && !keys.includes(mine)) {
        answer = true
        break
      }
    }
  } catch {
    answer = false
  }
  lockCache.set(key, answer)
  return answer
}

/**
 * The coupons a reminder is about: still money (`spendable`: no licence, no terminal credential,
 * nothing spent), spendable by ME (not P2PK-locked to someone else), and not my own issue. A
 * stall does not need reminding about coupons it issued: those are its customers' money, and
 * merchants already have "Expiring soon" for them.
 */
export function heldByMe(rows: VoucherRow[], me: string): VoucherRow[] {
  const self = issuerKey(me)
  return spendable(rows).filter(
    (row) => issuerKey(row.issuer_id) !== self && !lockedToSomeoneElse(row, me),
  )
}

export type Threshold = '7d' | '1d'

export interface ReminderCandidate {
  row: VoucherRow
  threshold: Threshold
  state: Extract<ExpiryState, { kind: 'live' }>
}

/** The bell entry's id. Stable, so the inbox and the filed set dedupe on it. */
export function reminderId(tokenId: string, threshold: Threshold): string {
  return `coupon-expiring:${tokenId}:${threshold}`
}

/**
 * Coupons inside a reminder window, soonest first, each with the TIGHTEST threshold it has
 * crossed. A coupon first seen with 12 hours left gets "1d" only: a "7 days" entry would be
 * stale the moment it was filed.
 */
export function reminderCandidates(rows: VoucherRow[], me: string, now = Date.now()): ReminderCandidate[] {
  // One per VOUCHER (voucherCount.ts): a voucher filed as six rows is one reminder, one banner
  // count and one line, at its whole value. Its rows share the voucher's signed expiry.
  const out: ReminderCandidate[] = []
  for (const voucher of groupByVoucher(heldByMe(rows, me))) {
    const row = asOneVoucher(voucher)
    const state = expiryState(row, now)
    if (!isExpiringSoon(state)) continue
    out.push({ row, state, threshold: state.tone === 'urgent' ? '1d' : '7d' })
  }
  return out.sort((a, b) => a.state.msLeft - b.state.msLeft)
}

/** The home banner's words. */
export function bannerText(count: number): string {
  return count === 1 ? '1 voucher expires this week' : `${count} vouchers expire this week`
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type CouponSort = 'expiry' | 'newest'

/**
 * Where a coupon falls in the expiry order: the spend order of #157 (`wallet-core` `expiryMs`).
 * Unreadable first (it might lapse tomorrow), then soonest, never-expiring last.
 */
function expiryRank(row: VoucherRow): number {
  const e = readExpiry(row.expires_at)
  if (e.kind === 'at') return e.seconds * 1000
  if (e.kind === 'none') return Number.MAX_SAFE_INTEGER
  return Number.MIN_SAFE_INTEGER
}

const newestFirst = (a: VoucherRow, b: VoucherRow) =>
  String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))

/**
 * A coupon list in the chosen order. `expiry` is the default on the list screen: it is the order
 * the wallet SPENDS in (#157), so the list reads in the order money will leave, and the coupon
 * that needs using first is at the top. `newest` keeps the received-date order the list had.
 */
export function sortCoupons(rows: VoucherRow[], mode: CouponSort): VoucherRow[] {
  const copy = rows.slice()
  if (mode === 'newest') return copy.sort(newestFirst)
  return copy.sort((a, b) => expiryRank(a) - expiryRank(b) || newestFirst(a, b))
}

/** Unspent coupons past their expiry, across every stall. */
function expiredRows(rows: VoucherRow[], now: number): VoucherRow[] {
  return spendable(rows).filter((row) => expiryState(row, now).kind === 'expired')
}

/**
 * One stall's expired coupons, most recently expired first: the "Expired" group under the live
 * list, instead of the coupon vanishing with no explanation. Never counted as money.
 */
export function expiredFor(rows: VoucherRow[], pubkey: string, now = Date.now()): VoucherRow[] {
  const target = issuerKey(pubkey)
  return expiredRows(rows, now)
    .filter((row) => issuerKey(row.issuer_id) === target)
    .sort((a, b) => (toEpochMs(b.expires_at) ?? 0) - (toEpochMs(a.expires_at) ?? 0))
}

/** How many held coupons have expired, for the note under the home balance. */
export function expiredCount(rows: VoucherRow[], now = Date.now()): number {
  return expiredRows(rows, now).length
}

/** A stall's soonest coupon inside the 7-day window: the cue on its deck card and page. */
export function soonestExpiring(
  rows: VoucherRow[],
  pubkey: string,
  now = Date.now(),
): { row: VoucherRow; state: Extract<ExpiryState, { kind: 'live' }> } | undefined {
  const target = issuerKey(pubkey)
  let best: { row: VoucherRow; state: Extract<ExpiryState, { kind: 'live' }> } | undefined
  for (const row of spendable(rows)) {
    if (issuerKey(row.issuer_id) !== target) continue
    const state = expiryState(row, now)
    if (!isExpiringSoon(state)) continue
    if (!best || state.msLeft < best.state.msLeft) best = { row, state }
  }
  return best
}
