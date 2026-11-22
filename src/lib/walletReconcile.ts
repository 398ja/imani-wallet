import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

import { pruneMintSpent, restoreVouchers } from './voucherRecords'

/**
 * Converge this device with the others on the same key: re-read the coupon
 * records (picking up tombstones another device published), then ask the mint
 * about every coupon still counted as money. Runs at start and every time the
 * app comes back to the foreground: an Android WebView sits backgrounded for
 * days, and login-only restore meant it never learnt of a browser's spends.
 */
export const MIN_INTERVAL_MS = 30_000

let inFlight: Promise<void> | null = null
let lastRun = 0

export function reconcileWallet(pubkey: string, now = Date.now()): Promise<void> {
  if (inFlight) return inFlight
  if (lastRun && now - lastRun < MIN_INTERVAL_MS) return Promise.resolve()
  lastRun = now
  inFlight = (async () => {
    try {
      await restoreVouchers(pubkey)
      await pruneMintSpent(pubkey)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Run on resume (Capacitor `resume` on Android, `visibilitychange` in a browser). Returns a stop function. */
export function reconcileOnResume(pubkey: string): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') void reconcileWallet(pubkey)
  }
  document.addEventListener('visibilitychange', onVisible)
  let remove: (() => void) | undefined
  let stopped = false
  if (Capacitor.isNativePlatform()) {
    void App.addListener('resume', () => void reconcileWallet(pubkey)).then((handle) => {
      if (stopped) void handle.remove()
      else remove = () => void handle.remove()
    })
  }
  return () => {
    stopped = true
    document.removeEventListener('visibilitychange', onVisible)
    remove?.()
  }
}

export function resetReconcileForTests(): void {
  inFlight = null
  lastRun = 0
}
