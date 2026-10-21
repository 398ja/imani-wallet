import { useEffect, useState } from 'react'

import { runCashlinkExpiryNoticesIfSettled } from '../lib/cashlinkExpiryNotice'
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
      // #295 phase 0: "Your Cashlink expired. Open Imani to take it back." Same clock, same
      // triggers: a link's expiry is crossed by time, not by an event. Never throws.
      if (live) void runCashlinkExpiryNoticesIfSettled(pubkey)
    }
    check()
    const timer = setInterval(check, RECHECK_MS)
    const unsubscribe = onWalletChanged(check)
    // A phone woken after days: background tabs throttle timers, so the hourly tick may not have
    // run. Coming back to the app is the "open" a customer means.
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
    return () => {
      live = false
      window.removeEventListener('focus', check)
      clearInterval(timer)
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [pubkey, ready])
}

/**
 * A re-render tick for screens that show expiry (#265): hourly, and whenever the app comes back
 * into view. A badge is a function of the clock, and nothing else changes when a coupon crosses
 * into its last day, so without this a screen left open (or a phone woken after a weekend) would
 * keep saying "5 days" until some unrelated write re-rendered it. Returns a number to depend on.
 */
export function useExpiryClock(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    const timer = setInterval(bump, RECHECK_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') bump()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', bump)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', bump)
    }
  }, [])
  return tick
}
