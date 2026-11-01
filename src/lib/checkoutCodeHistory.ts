/**
 * Checkout codes in the wallet's history (#402): one transaction row per code, kept current.
 *
 * The row is an ordinary `TransactionRow` (id `checkout:<code id>`, type `checkout_code`), written
 * through the wallet's wrapped `addTransaction`, so it is published to the relay (`txRecords.ts`)
 * and comes back on restore like every other row. It carries a small snapshot of the code
 * (`checkoutCode`): the record in localStorage is the authority while the code is outstanding, and
 * the snapshot is what survives a logout once it is not (logout is refused while one is
 * outstanding, so the record is never lost while it still holds value).
 *
 * Funds: the coupons a code is made from leave the coupon list when they are locked, and come back
 * as new coupon rows (cancel, expiry, change). Balances are read from coupon rows only, so this row
 * never adds to or subtracts from a balance: it describes where the value is. One row per code,
 * never one per status change, so the history reads one movement, not several.
 */
import type { CheckoutCodeRecord, CheckoutCodeStatus } from './checkoutCodeRecords'

export const CHECKOUT_CODE_TX_TYPE = 'checkout_code'

/** Status words, the same ones the code screen uses. */
export const CHECKOUT_STATUS_WORDS: Record<CheckoutCodeStatus, string> = {
  reserved: 'Ready to use',
  held: 'In a checkout',
  cancelling: 'Cancelling',
  redeemed: 'Used',
  cancelled: 'Cancelled',
  expired: 'Expired',
  depositing: 'Being made',
  locking: 'Being made',
  abandoned: 'Not made',
}

/** The snapshot of a code that rides on its history row. Nothing secret. */
export interface CheckoutCodeSnapshot {
  id: string
  status: CheckoutCodeStatus
  shopHost: string
  /** Minor units the shop spent, once redeemed. */
  spent?: number
}

/** Where the code's value is, for the row's amount. */
export type CheckoutFunds = 'committed' | 'spent' | 'returned'

export function checkoutFunds(s: Pick<CheckoutCodeSnapshot, 'status'>): CheckoutFunds {
  if (s.status === 'redeemed') return 'spent'
  if (s.status === 'cancelled' || s.status === 'expired' || s.status === 'abandoned') return 'returned'
  return 'committed'
}

export const checkoutTxId = (codeId: string) => `checkout:${codeId}`

/** `checkout:<id>` or `checkout:<id>:<what>` back to the code id. */
export function codeIdOfActivity(rowId: string): string | undefined {
  const m = /^checkout:([^:]+)/.exec(rowId)
  return m?.[1]
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

const STATUSES = new Set(Object.keys(CHECKOUT_STATUS_WORDS))

export function asCheckoutCodeSnapshot(value: unknown): CheckoutCodeSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || typeof v.status !== 'string' || !STATUSES.has(v.status)) return undefined
  return {
    id: v.id,
    status: v.status as CheckoutCodeStatus,
    shopHost: typeof v.shopHost === 'string' ? v.shopHost : '',
    ...(typeof v.spent === 'number' ? { spent: v.spent } : {}),
  }
}

/** The history row for a code, in the camelCase shape every writer uses. */
export function checkoutCodeRow(record: CheckoutCodeRecord, memo?: string): Record<string, unknown> {
  const snapshot: CheckoutCodeSnapshot = {
    id: record.id,
    status: record.status,
    shopHost: hostOf(record.shopUrl),
    ...(record.spent !== undefined ? { spent: record.spent } : {}),
  }
  return {
    id: checkoutTxId(record.id),
    txId: checkoutTxId(record.id),
    type: CHECKOUT_CODE_TX_TYPE,
    direction: 'out',
    timestamp: record.createdAt,
    // What left the coupon list for the code; a redeemed code shows what the shop spent.
    amount: record.status === 'redeemed' && record.spent !== undefined ? record.spent : record.amount,
    unit: record.unit,
    decimals: record.decimals,
    merchantId: record.stall,
    ...(memo ? { memo } : {}),
    checkoutCode: snapshot,
  }
}
