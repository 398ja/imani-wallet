import type { VoucherRow } from '@imani/wallet-storage'
import { roundedOnceTotal } from './couponTotals'

/**
 * Vouchers, not rows (one voucher can be stored as several rows).
 *
 * The wallet stores one row per TOKEN, and a few flows file a voucher's value back as one row per
 * proof: a checkout code's change, a Cashlink take-back, a relay refund, a NUT-09 restore
 * (`faceSplit.ts`, `couponTotals.ts`). Six proofs of one €8.99 voucher became six rows, and every
 * screen that counted rows told the holder they had "6 vouchers" when they held one. A customer
 * reads "voucher" as the thing the stall gave them, so the count is of those.
 *
 * Keyed on `voucher_id`, which every writer stamps from the token's own signed voucher
 * (`parsed.voucher.voucherId`, a UUID minted per issuance by gateway-customer). With the issuer
 * too, so two stalls can never collide on one id. A row without a `voucher_id` is its own voucher:
 * unknown is never merged into something else.
 */
export function voucherKey(row: Pick<VoucherRow, 'token_id' | 'voucher_id' | 'issuer_id'>): string {
  const id = typeof row.voucher_id === 'string' && row.voucher_id !== '' ? row.voucher_id : undefined
  return id ? `v:${String(row.issuer_id ?? '').toLowerCase()}:${id}` : `t:${row.token_id}`
}

/** How many vouchers these rows are. */
export function countVouchers(rows: readonly Pick<VoucherRow, 'token_id' | 'voucher_id' | 'issuer_id'>[]): number {
  return new Set(rows.map(voucherKey)).size
}

/** A voucher held as one or more rows. The first row is the one the list links to. */
export interface HeldVoucher {
  key: string
  rows: VoucherRow[]
  /**
   * The voucher's face, minor units: its rows rounded ONCE (`roundedOnceTotal`), the figure the
   * balance counts it at, so the list never shows a cent the balance does not.
   */
  faceValue: number
}

/**
 * Rows folded into vouchers, in the order of each voucher's first row. Only rows of one unit
 * should be passed (a stall's list is one issuer; a voucher has one unit by construction).
 */
export function groupByVoucher(rows: readonly VoucherRow[]): HeldVoucher[] {
  const out = new Map<string, HeldVoucher>()
  for (const row of rows) {
    const key = voucherKey(row)
    const held = out.get(key)
    if (held) held.rows.push(row)
    else out.set(key, { key, rows: [row], faceValue: 0 })
  }
  for (const held of out.values()) {
    held.faceValue = held.rows.length === 1 ? Number(held.rows[0]!.face_value ?? 0) : roundedOnceTotal(held.rows)
  }
  return [...out.values()]
}

/**
 * The row a list draws for a held voucher: its first row, carrying the voucher's whole face.
 * Links to that row's detail screen, which then shows the voucher (see `siblingsOf`).
 */
export function asOneVoucher(voucher: HeldVoucher): VoucherRow {
  const first = voucher.rows[0]!
  return voucher.rows.length === 1 ? first : { ...first, face_value: voucher.faceValue }
}

/**
 * Every row of the voucher `row` belongs to, among `all` (itself included), so a detail screen
 * opened on one of a voucher's rows shows the voucher. Only rows in the same state: a spent row of
 * the voucher is a receipt, not part of what is still held.
 */
export function siblingsOf(row: VoucherRow, all: readonly VoucherRow[]): VoucherRow[] {
  const key = voucherKey(row)
  if (key.startsWith('t:')) return [row]
  const state = String(row.status ?? '').toLowerCase()
  const rows = all.filter((r) => voucherKey(r) === key && String(r.status ?? '').toLowerCase() === state)
  return rows.some((r) => r.token_id === row.token_id) ? rows : [row, ...rows]
}
