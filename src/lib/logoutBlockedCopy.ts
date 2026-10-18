import { formatFace, formatSats } from './format'
import { LOGOUT_BLOCKED_COPY, type LogoutOutcome } from './logout'
import type { UnconfirmedCoupon } from './voucherRecords'

/** A refused logout (owner rule 2026-10-18, review of #326). */
export type BlockedLogout = Extract<LogoutOutcome, { status: 'blocked' }>

/** "£13.50", or "£11.00 + 72 sats" across units. Never a token, never an id. */
export function unconfirmedValue(coupons: UnconfirmedCoupon[]): string {
  const minorByUnit = new Map<string, { minor: number; decimals: number }>()
  let sats = 0
  for (const coupon of coupons) {
    if ((coupon.status ?? '').toLowerCase() === 'swapped_to_sats' && typeof coupon.sats_amount === 'number') {
      sats += coupon.sats_amount
      continue
    }
    const unit = coupon.face_unit ?? ''
    const entry = minorByUnit.get(unit) ?? { minor: 0, decimals: coupon.face_decimals ?? 0 }
    entry.minor += Number(coupon.face_value ?? 0)
    minorByUnit.set(unit, entry)
  }
  const parts = [...minorByUnit.entries()]
    .filter(([, v]) => v.minor > 0)
    .map(([unit, v]) => formatFace(v.minor, { unit, decimals: v.decimals }))
  if (sats > 0) parts.push(`${formatSats(sats)} sats`)
  return parts.length > 0 ? parts.join(' + ') : 'an unknown amount'
}

/** The refusal in plain words, with the count and the value where there are any. */
export function blockedMessage(outcome: BlockedLogout): string {
  switch (outcome.reason) {
    case 'locked':
      return LOGOUT_BLOCKED_COPY.locked
    case 'store-unreadable':
      return LOGOUT_BLOCKED_COPY.unreadable
    case 'changed':
      return LOGOUT_BLOCKED_COPY.changed
    default:
      return LOGOUT_BLOCKED_COPY.unconfirmed(outcome.unconfirmed.length, unconfirmedValue(outcome.unconfirmed))
  }
}
