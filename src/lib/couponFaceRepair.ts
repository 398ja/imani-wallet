/**
 * Coupon rows whose stored face value is more than their token can be credited for (#402), and the
 * figure they should show.
 *
 * Making a checkout code carves whole proofs off a coupon (`checkoutCarve.ts`). Until v0.46.3 the row
 * left behind kept the coupon's whole face value while its token lost the carved proofs, so the balance
 * kept showing what the code had already taken (staging 2026-11-01: 5.19 shown, 5.10 usable online,
 * the 9 c difference being one carved part). The carve now restates the row; this restates the rows a
 * carve already overstated.
 *
 * Only ever DOWN, and only past rounding: a stored figure within one minor unit of the token's credit
 * is the gateway's own rounding of a split (`keep_face_value`) and is left alone, and a stored figure
 * below the credit is never raised.
 */
import type { VoucherRow } from '@imani/wallet-storage'
import { getWallet, listVouchers, notifyWalletChanged } from './wallet'
import { creditableFaceValue, parseVoucherToken } from './voucherToken'

/** The face this row should show, or null when its stored figure is right. Pure. Never throws. */
export function restatedFace(row: Pick<VoucherRow, 'token' | 'face_value' | 'status'>): number | null {
  if (!row.token || typeof row.face_value !== 'number') return null
  const status = String(row.status ?? '').toLowerCase()
  if (status !== '' && status !== 'active') return null
  let credit: number
  try {
    credit = creditableFaceValue(parseVoucherToken(row.token)).faceValue
  } catch {
    return null
  }
  return row.face_value - credit > 1 ? credit : null
}

let running: Promise<number> | null = null

/** Restate every overstated row; returns how many were rewritten. One pass at a time, never throws. */
export function restateOverstatedRowsNow(): Promise<number> {
  running ??= (async () => {
    const wallet = getWallet()
    let n = 0
    for (const row of await listVouchers()) {
      const face = restatedFace(row)
      if (face === null) continue
      await wallet.saveVoucher({ ...row, face_value: face, updated_at: new Date().toISOString() } as Parameters<typeof wallet.saveVoucher>[0])
      n += 1
    }
    if (n) notifyWalletChanged()
    return n
  })()
    .catch(() => 0)
    .finally(() => {
      running = null
    })
  return running
}
