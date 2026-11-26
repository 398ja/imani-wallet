import type { VoucherRow } from '@imani/wallet-storage'

import { expiryState } from './couponExpiry'
import type { VoucherStatusKind } from './voucherRowCopy'

/**
 * What a held voucher IS, for its row's badge. The stored `status` is the proofs' state; an
 * expired voucher's proofs are unspent, so expiry is read from the clock (#265), and only for a
 * voucher that is otherwise still money. A spent one keeps what happened to it.
 */
export function voucherStatusKind(row: Pick<VoucherRow, 'status' | 'expires_at'>, now?: number): VoucherStatusKind {
  const stored = String(row.status ?? 'active').toLowerCase()
  switch (stored) {
    case 'redeemed':
      return 'redeemed'
    case 'spent':
      return 'spent'
    case 'swapped_to_sats':
      return 'swapped'
    case 'fully_redeemed':
      return 'refused'
    case 'pending':
    case 'minting':
    case 'locking':
    case 'waiting':
      return expiryState(row, now).kind === 'expired' ? 'expired' : 'pending'
    case 'active':
      return expiryState(row, now).kind === 'expired' ? 'expired' : 'active'
    default:
      return expiryState(row, now).kind === 'expired' ? 'expired' : 'other'
  }
}
