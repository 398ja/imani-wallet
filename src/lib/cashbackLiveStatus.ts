/**
 * The merchant screen's live cashback status (claim links phase 2, spec 4.1).
 *
 * While the success screen is open it asks the portal every 5 seconds whether the customer has
 * claimed, so the QR can turn into "Claimed just now". Gentle on purpose:
 *  - it reads the merchant's own authenticated `/status`, never the public metadata, whose
 *    per-address limiter (shared with the customer prompt on the same network) locks out for
 *    300 s;
 *  - a failed read backs off (5, 10, 20, 40, then 60 s), and a success resets it;
 *  - a hidden page asks nothing, and a page that becomes visible asks at once;
 *  - a final status stops it for good.
 */
import { useEffect, useState } from 'react'

import { fetchCashbackStatus, isTerminalCashbackStatus, type CashbackStatusReading } from './cashback'

export const POLL_BASE_MS = 5_000
export const POLL_MAX_MS = 60_000

/** How long to wait before the next read, after `failures` failed reads in a row. */
export function nextPollDelay(failures: number): number {
  const exponent = Math.max(0, Math.min(failures, 10))
  return Math.min(POLL_BASE_MS * 2 ** exponent, POLL_MAX_MS)
}

export interface PollerDeps {
  read: (cashbackId: string) => Promise<CashbackStatusReading | null>
  onReading: (reading: CashbackStatusReading) => void
  isVisible: () => boolean
  setTimer: (run: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

/**
 * Poll one cashback until it settles or `stop` is called. Returns `stop` and `wake`: `wake` is
 * for the page becoming visible again, and reads at once if nothing is in flight.
 */
export function startStatusPoller(cashbackId: string, deps: PollerDeps): { stop: () => void; wake: () => void } {
  let failures = 0
  let timer: unknown = null
  let inFlight = false
  let stopped = false

  const schedule = (ms: number) => {
    if (stopped) return
    timer = deps.setTimer(tick, ms)
  }

  async function tick() {
    timer = null
    if (stopped || inFlight) return
    // Hidden: ask nothing. `wake` restarts the loop when the page is shown again.
    if (!deps.isVisible()) return
    inFlight = true
    const reading = await deps.read(cashbackId).catch(() => null)
    inFlight = false
    if (stopped) return
    if (reading) {
      failures = 0
      deps.onReading(reading)
      if (isTerminalCashbackStatus(reading.status)) {
        stopped = true
        return
      }
    } else {
      failures += 1
    }
    schedule(nextPollDelay(failures))
  }

  schedule(POLL_BASE_MS)

  return {
    stop() {
      stopped = true
      if (timer !== null) deps.clearTimer(timer)
      timer = null
    },
    wake() {
      if (stopped || inFlight) return
      if (timer !== null) deps.clearTimer(timer)
      timer = null
      void tick()
    },
  }
}

/**
 * The live status of the cashback on screen, or null until the first answer. `live` false
 * stops polling (for example once the merchant has cancelled it).
 */
export function useLiveCashbackStatus(cashbackId: string | undefined, live = true): CashbackStatusReading | null {
  const [reading, setReading] = useState<{ id: string; reading: CashbackStatusReading } | null>(null)

  useEffect(() => {
    if (!cashbackId || !live) return
    const poller = startStatusPoller(cashbackId, {
      read: fetchCashbackStatus,
      onReading: (r) => setReading({ id: cashbackId, reading: r }),
      isVisible: () => document.visibilityState !== 'hidden',
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
    })
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') poller.wake()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      poller.stop()
    }
  }, [cashbackId, live])

  return reading && reading.id === cashbackId ? reading.reading : null
}
