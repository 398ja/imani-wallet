/**
 * What a Cashlink really takes from the balance, before it is made (the NGN overcharge, #635).
 *
 * `sendGift` tries the locked path first (#543): a plan whose parts are carved, or split, to add up
 * to exactly the request, so exactly the request leaves. When no such plan exists, or the path is
 * not open to this wallet (a merchant, a remote signer), it falls back to the ordinary send, where a
 * coupon whose sat is worth more than a minor unit (NGN, KES) sends the fewest sats worth the request,
 * up to a sat more (`sendFace.ts`). That is the figure Send and Pay already show (`debitFor`).
 *
 * The same estimate as theirs: a coupon refused at the tap moves the send on, which is rare and
 * which the done screen then states exactly (what the gateway confirmed left). Pure. Never throws.
 */
import type { Voucher } from '@imani/voucher-send'
import type { VoucherRow } from '@imani/wallet-storage'

import { checkoutPlan, type CheckoutPart } from './checkoutPlan'
import { giftExclusion } from './giftLink'
import { debitFor } from './pay'

/**
 * The parts of a Cashlink for `amount` of `stall`'s `unit`, by the checkout planner, over the coupons
 * a gift may carry (`giftExclusion`). Null when no plan meets it: the legacy path then decides.
 */
export function planDirectParts(req: { rows: VoucherRow[]; payer: string; stall: string; unit: string; amount: number; x: number; nowS: number }): CheckoutPart[] | null {
  const giftable = req.rows.filter((r) => giftExclusion(r.token, r.issuer_id, req.payer, req.nowS * 1000) === null)
  const plan = checkoutPlan({ rows: giftable, payer: req.payer, stallId: req.stall, unit: req.unit, amount: req.amount, x: req.x, nowS: req.nowS })
  return plan.plan ?? null
}

export interface CashlinkDebitRequest {
  rows: VoucherRow[]
  /** The coupons the legacy send chooses from: the picked merchant and unit's. */
  vouchers: Voucher[]
  payer: string
  stall: string
  unit: string
  amount: number
  /** The link's expiry, unix seconds, as the send will use it. */
  x: number
  nowS: number
  /** Whether the locked path is open to this wallet: not a merchant, and its key can be read. */
  direct: boolean
}

/** Minor units the Cashlink will take: the request, or up to a sat more on the ordinary send. */
export function cashlinkDebit(req: CashlinkDebitRequest): number {
  try {
    if (!Number.isSafeInteger(req.amount) || req.amount <= 0) return req.amount
    if (req.direct && planDirectParts(req) !== null) return req.amount
    return debitFor(req.vouchers, req.amount)
  } catch {
    return req.amount
  }
}
