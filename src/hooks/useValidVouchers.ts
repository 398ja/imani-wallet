import { useEffect, useState } from 'react'

import { listVouchers, onWalletChanged, walletIsOpen } from '../lib/wallet'
import { withoutInFlight } from '../lib/pay'
import { validVoucherCount } from '../lib/merchantActions'

/**
 * This stall's coupons the viewer can still spend: unspent, unexpired, and not behind an
 * unconfirmed send (#128), so neither Pay nor Coupon code leads to a "none left" refusal.
 */
export function useValidVouchers(pubkey: string, viewerPubkey?: string): number {
  const [valid, setValid] = useState(0)
  useEffect(() => {
    // `listVouchers` throws with no wallet open, and a visitor has nothing to
    // count anyway, so the load is skipped rather than caught.
    if (viewerPubkey === undefined || !walletIsOpen()) return
    const load = async () => {
      const rows = withoutInFlight(await listVouchers(), viewerPubkey)
      setValid(validVoucherCount(rows, pubkey))
    }
    void load()
    return onWalletChanged(() => void load())
  }, [pubkey, viewerPubkey])
  return valid
}
