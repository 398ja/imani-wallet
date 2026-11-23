/**
 * The pull on login for card sales (imani-wallet#275 item 3, card atomicity U9).
 *
 * After each mint the purchase issuer sends the stall a sealed sale record (`tillSales.ts` files
 * it). One that never arrived, or a device restored without it, left a card sale missing from the
 * stall's own books. On login this:
 *
 * 1. lists the stall's card sales from payment-adapter (`GET /api/v1/purchases?stall=<self>`,
 *    NIP-98 as the stall), the service that recorded the payment;
 * 2. asks the purchase issuer to re-send the record of every sale with no `issued:<voucher>` row
 *    (`POST /api/v1/card-sales/sales/resend`, NIP-98 as the stall). The issuer rebuilds each from
 *    payment-adapter's list, not from what this sends, and the stall files it through the same
 *    checks as any other record (`collectTillSales`);
 * 3. cross-checks the sale time of every card row it already has against the payment time
 *    payment-adapter recorded (review residual R1: the sale time was the sender's word). A row
 *    more than `SALE_TIME_TOLERANCE_MS` away is re-dated to the payment time, the sender's time is
 *    kept beside it as `senderSaleAt`, and the mismatch is logged.
 *
 * Never throws, and every failure is "try again next login": a stall's books must never lose a
 * row because a service was down.
 */
import type { TransactionRow } from '@imani/wallet-storage'

import { cardReferenceOf } from './paymentReference'
import { isCardReference } from './cardProcessor'
import { signedFetch } from './nip98'
import { toTransaction } from './transactions'

export const STALL_PURCHASES_PATH = '/api/v1/purchases'
export const RESEND_PATH = '/api/v1/card-sales/sales/resend'
/** Mirrors `MAX_RESEND` in `services/purchase-issuer/salePull.ts`. */
export const MAX_RESEND = 50
/**
 * How far a card row's own time may sit from the recorded payment. A mint follows the webhook by
 * seconds, a re-driven one by up to the claim lease (10 min) times its retries; an hour covers that
 * and still catches a record dated into another day.
 */
export const SALE_TIME_TOLERANCE_MS = 60 * 60 * 1000

/** One card sale as payment-adapter lists it for its stall. */
export interface StallCardSale {
  voucherId: string
  ref: string
  amountMinor: number
  currency: string
  /** Epoch ms payment-adapter recorded the payment. */
  paidAt: number
}

const VOUCHER_ID = /^[0-9A-Za-z-]{1,64}$/

export function parseStallCardSale(raw: unknown): StallCardSale | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const paidAt = typeof r.paid_at === 'string' ? Date.parse(r.paid_at) : NaN
  if (typeof r.voucher_id !== 'string' || !VOUCHER_ID.test(r.voucher_id)) return undefined
  if (typeof r.ref !== 'string' || !isCardReference(r.ref)) return undefined
  if (typeof r.amount_minor !== 'number' || !Number.isSafeInteger(r.amount_minor) || r.amount_minor <= 0) return undefined
  if (!Number.isFinite(paidAt) || paidAt <= 0) return undefined
  return {
    voucherId: r.voucher_id,
    ref: r.ref,
    amountMinor: r.amount_minor,
    currency: typeof r.currency === 'string' ? r.currency : '',
    paidAt,
  }
}

export interface PullDeps {
  /** The stall's card sales, or undefined when they could not be read. */
  listSales(stall: string): Promise<StallCardSale[] | undefined>
  /** Ask the issuer to re-send these records. False when it could not be asked. */
  requestResend(voucherIds: string[]): Promise<boolean>
  /** File whatever the inbox now holds (`collectTillSalesForOwner`). */
  collect(stall: string): Promise<number>
  getRow(id: string): Promise<TransactionRow | null>
  patchRow(id: string, patch: Partial<TransactionRow> & Record<string, unknown>): Promise<void>
}

export interface PullResult {
  listed: number
  missing: number
  requested: boolean
  filed: number
  redated: number
}

/** Steps 1 to 3 for one stall. Never throws. */
export async function pullCardSales(stallPubkey: string, deps: PullDeps): Promise<PullResult> {
  const result: PullResult = { listed: 0, missing: 0, requested: false, filed: 0, redated: 0 }
  try {
    const stall = stallPubkey.toLowerCase()
    const sales = await deps.listSales(stall)
    if (!sales || sales.length === 0) return result
    result.listed = sales.length

    const missing: string[] = []
    for (const sale of sales) {
      const row = await deps.getRow(`issued:${sale.voucherId}`)
      if (!row) {
        missing.push(sale.voucherId)
        continue
      }
      if (await crossCheckSaleTime(row, sale, deps)) result.redated += 1
    }
    result.missing = missing.length
    if (missing.length === 0) return result

    result.requested = await deps.requestResend(missing.slice(0, MAX_RESEND))
    if (!result.requested) return result
    result.filed = await deps.collect(stall)
    return result
  } catch (error) {
    console.warn('[cardSalePull] could not pull card sales', error)
    return result
  }
}

/**
 * R1: is this card row dated where payment-adapter says the payment was? Only a row whose signed
 * warrant carries the same card reference is judged; anything else is not this sale. True when re-dated.
 */
async function crossCheckSaleTime(row: TransactionRow, sale: StallCardSale, deps: PullDeps): Promise<boolean> {
  const tx = toTransaction(row)
  if (cardReferenceOf(tx.issuanceWarrant) !== sale.ref) return false
  if (tx.at > 0 && Math.abs(tx.at - sale.paidAt) <= SALE_TIME_TOLERANCE_MS) return false
  console.warn('[cardSalePull] card sale time disagrees with the recorded payment; using the payment time', {
    voucherId: sale.voucherId,
    senderSaleAt: tx.at,
    paidAt: sale.paidAt,
  })
  await deps.patchRow(tx.id, {
    timestamp: Math.floor(sale.paidAt / 1000),
    senderSaleAt: tx.at,
    saleTimeSource: 'payment-adapter',
  })
  return true
}

// ---------------------------------------------------------------- the network

/** payment-adapter's list, NIP-98 as the stall. */
export async function fetchStallCardSales(stall: string): Promise<StallCardSale[] | undefined> {
  try {
    const response = await signedFetch(`${STALL_PURCHASES_PATH}?stall=${stall.toLowerCase()}`, 'GET')
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (!Array.isArray(body)) return undefined
    return body.map(parseStallCardSale).filter((s): s is StallCardSale => s !== undefined)
  } catch {
    return undefined
  }
}

/** The issuer's resend, NIP-98 as the stall. */
export async function requestSaleResend(voucherIds: string[]): Promise<boolean> {
  try {
    const response = await signedFetch(RESEND_PATH, 'POST', { voucherIds })
    return response.ok
  } catch {
    return false
  }
}
