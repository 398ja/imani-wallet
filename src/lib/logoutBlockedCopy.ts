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

function shopName(url: string): string {
  try {
    return new URL(url).hostname || 'the shop'
  } catch {
    return url || 'the shop'
  }
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
    case 'in-flight':
      return LOGOUT_BLOCKED_COPY.inFlight
    case 'send-unknown':
      return LOGOUT_BLOCKED_COPY.sendUnknown
    case 'other-tab':
      return LOGOUT_BLOCKED_COPY.otherTab
    case 'key-not-backed-up':
      return LOGOUT_BLOCKED_COPY.keyNotBackedUp
    case 'checkout-code':
    case 'checkout-code-unconfirmed': {
      const c = outcome.code
      const shop = c ? shopName(c.shopUrl) : 'the shop'
      const amount = c ? formatFace(c.amount, { unit: c.unit, decimals: c.decimals }) : 'an unknown amount'
      if (outcome.reason === 'checkout-code-unconfirmed') return LOGOUT_BLOCKED_COPY.checkoutCodeUnconfirmed(shop, amount)
      const back = c ? new Date(c.x * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'its expiry date'
      return LOGOUT_BLOCKED_COPY.checkoutCode(shop, amount, back)
    }
    case 'cashback-unconfirmed':
      return LOGOUT_BLOCKED_COPY.cashbackUnconfirmed(outcome.cashback ?? 1)
    default:
      return LOGOUT_BLOCKED_COPY.unconfirmed(outcome.unconfirmed.length, unconfirmedValue(outcome.unconfirmed))
  }
}
