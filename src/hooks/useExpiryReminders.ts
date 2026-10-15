import { useEffect } from 'react'

import { runExpiryReminders } from '../lib/expiryReminders'
import { listVouchers, onWalletChanged } from '../lib/wallet'

/** A threshold is crossed by the clock, not by an event, so an open wallet re-checks hourly. */
const RECHECK_MS = 3_600_000

/**
 * Files the "voucher expiring" bell entries while the wallet is open (#265): once on open, on
 * every change to the stored coupons, and hourly. Local only: it reads IndexedDB and writes the
 * bell's localStorage, and never calls a server. `ready` is the wallet having opened, because
 * `onWalletChanged` throws before that.
 */
export function useExpiryReminders(pubkey: string, ready: boolean): void {
  useEffect(() => {
    if (!ready || !pubkey) return
    let live = true
    const check = () => {
      listVouchers().then(
        (rows) => {
          if (live) runExpiryReminders(pubkey, rows)
        },
        () => undefined,
      )
    }
    check()
    const timer = setInterval(check, RECHECK_MS)
    const unsubscribe = onWalletChanged(check)
    return () => {
      live = false
      clearInterval(timer)
      unsubscribe()
    }
  }, [pubkey, ready])
}
