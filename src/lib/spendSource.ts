/**
 * Where a coupon that came back to its stall was spent (imani-wallet#402 traceability).
 *
 * An online shop that redeems a checkout code sends the stall its vouchers with a `source` block on
 * the `cashu_token_transfer` envelope (imani-coupon-core StallHandoff::payload): the shop's URL, the
 * platform, the order number its customer sees, the shop's own order ref, the code's log id (a hash
 * prefix, never the code) and the amount the code applied. The stall's books show it on the incoming
 * payment and on the voucher's own record, so a merchant can trace each voucher from the sale that
 * issued it to the order that spent it.
 *
 * DECLARED, not proven. The envelope is sealed by the shop's key, which the stall enrolled, so it is
 * the shop's word about its own order; nothing here books or caps money from it. Anything malformed
 * is dropped, never half-kept.
 */

export interface SpendSource {
  kind: 'online_shop'
  shopUrl: string
  /** Host of `shopUrl`, for display. */
  shopHost: string
  platform?: string
  orderNumber?: string
  orderRef?: string
  codeRef?: string
  /** Minor units the code applied to the order. */
  amountApplied?: number
}

const MAX = 200

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' && v.length <= MAX ? v.trim() : undefined

/** From the wire (snake_case, the envelope) or a stored row (camelCase). Undefined unless usable. */
export function parseSpendSource(raw: unknown): SpendSource | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (r.kind !== 'online_shop') return undefined
  const shopUrl = text(r.shop_url ?? r.shopUrl)
  if (!shopUrl) return undefined
  let host: string
  try {
    const u = new URL(shopUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    host = u.hostname
  } catch {
    return undefined
  }
  const amount = r.amount_applied ?? r.amountApplied
  const orderNumber = r.order_number ?? r.orderNumber
  return {
    kind: 'online_shop',
    shopUrl,
    shopHost: host,
    ...(text(r.platform) ? { platform: text(r.platform) } : {}),
    ...(text(typeof orderNumber === 'number' ? String(orderNumber) : orderNumber)
      ? { orderNumber: text(typeof orderNumber === 'number' ? String(orderNumber) : orderNumber) }
      : {}),
    ...(text(r.order_ref ?? r.orderRef) ? { orderRef: text(r.order_ref ?? r.orderRef) } : {}),
    ...(text(r.code_ref ?? r.codeRef) ? { codeRef: text(r.code_ref ?? r.codeRef) } : {}),
    ...(typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? { amountApplied: amount } : {}),
  }
}

/** "Order 55 at shop.example", or "Online at shop.example" without a number. */
export function spendSourceLabel(s: SpendSource): string {
  return s.orderNumber ? `Order ${s.orderNumber} at ${s.shopHost}` : `Online at ${s.shopHost}`
}
