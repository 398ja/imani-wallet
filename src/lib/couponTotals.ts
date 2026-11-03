/**
 * Coupon totals rounded ONCE per voucher (staging 2026-11-02, "georges 8.98 vs 8.99").
 *
 * A checkout code's change comes back as one coupon row per re-signed proof. Each row's face is its
 * token's credit, `creditableFaceValue`, which rounds on its own: 8192 + 4096 + 512 + 128 + 64 + 16
 * sats at 0.0691443 c/sat is 899.43 c exactly, but the six rows round to 566 + 283 + 35 + 9 + 4 + 1
 * = 898. Nothing is lost.
 *
 * The rule: a voucher's total is `floor(sum of its rows' exact shares)`, clamped to the signed face.
 * FLOOR, not round, because that is what the redemption ledger books for the same parts
 * (`cumulativeCredit` in `@imani/redemption`: the credits of a voucher's parts always sum to
 * `floor(total exact)`), so the total never shows a cent the coupons cannot cover (899.6 shows 899,
 * never 900). A voucher held as one row keeps its stored figure.
 *
 * Spending still draws per row (each part is credited `creditableFaceValue` of its own token), so
 * what a spend may draw is `spendableTotal`: the smaller of the per-row sum and this total.
 */
import type { VoucherRow } from '@imani/wallet-storage'
import { creditableFaceValue, exactFaceValue, parseVoucherToken, tokenProofs, voucherOfSecret } from './voucherToken'

type Row = Pick<VoucherRow, 'token' | 'face_value'> & { voucher_id?: string | null; status?: string | null }

/** What one row reads as for a total, or null when it cannot be read (then it counts as stored). */
function readable(row: Row): { voucherId: string; exact: number; credit: number; faceCap: number } | null {
  try {
    // Only active money is rounded together: anything else counts as stored.
    const status = String(row.status ?? '').toLowerCase()
    if (status !== '' && status !== 'active') return null
    if (tokenProofs(row.token).some((p) => voucherOfSecret(p.secret)?.lockKey)) return null
    const parsed = parseVoucherToken(row.token)
    const { faceValue: credit } = creditableFaceValue(parsed)
    // A stored figure that is not the token's own credit (give or take the gateway's rounding of a
    // split) was set on purpose (#384 shares, a restated carve): it is summed as stored.
    if (typeof row.face_value !== 'number' || Math.abs(row.face_value - credit) > 1) return null
    return { voucherId: `${parsed.voucher.voucherId}|${parsed.mintUrl}|${parsed.voucher.unit}`, exact: exactFaceValue(parsed), credit, faceCap: parsed.voucher.faceValue }
  } catch {
    return null
  }
}

/**
 * The total of these coupon rows, minor units: exact shares summed per voucher and rounded once
 * (`Math.floor`, clamped to the voucher's signed face), what the redemption ledger credits them for.
 * A voucher held as one row counts its stored face, unchanged. Assumes one unit (callers group).
 */
export function roundedOnceTotal(rows: readonly Row[]): number {
  let total = 0
  const byVoucher = new Map<string, { rows: Row[]; exact: number; stored: number; cap: number }>()
  for (const row of rows) {
    const r = readable(row)
    if (!r) {
      total += Number(row.face_value ?? 0)
      continue
    }
    const g = byVoucher.get(r.voucherId) ?? { rows: [], exact: 0, stored: 0, cap: r.faceCap }
    g.rows.push(row)
    g.exact += r.exact
    g.stored += Number(row.face_value ?? 0)
    byVoucher.set(r.voucherId, g)
  }
  for (const g of byVoucher.values()) {
    if (g.rows.length === 1) {
      total += g.stored
      continue
    }
    const once = Math.floor(g.exact + 1e-9)
    total += g.cap > 0 ? Math.min(once, g.cap) : once
  }
  return total
}

/**
 * What a spend may draw from these rows, minor units: never more than the per-row credits a spend
 * draws part by part, and never more than `roundedOnceTotal` (what the ledger covers).
 */
export function spendableTotal(rows: readonly (Row & { face_value?: number | null })[], perRow: readonly number[] = rows.map((r) => Number(r.face_value ?? 0))): number {
  return Math.min(perRow.reduce((s, v) => s + v, 0), roundedOnceTotal(rows))
}
