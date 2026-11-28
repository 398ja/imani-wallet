import { useCallback, useEffect, useState } from 'react'

import { listInstalmentPlans, type InstalmentPlan } from '../lib/instalments'

/**
 * The signed-in buyer's Monthly payments, read once when the wallet opens.
 *
 * There is no push from payment-adapter, so a failed payment is learned here, on load
 * (monthly payments spec, "Failed payments"). One module-level read is shared by every
 * consumer on screen at once (home banner, Settings row, a stall's line), so opening the wallet
 * signs one request, not three.
 *
 * `null` while loading or when the read failed: every consumer treats unknown as "show
 * nothing", so an unreachable payment service never draws a banner or a row.
 */
let shared: { key: string; promise: Promise<InstalmentPlan[] | null> } | null = null

function load(key: string, force: boolean): Promise<InstalmentPlan[] | null> {
  if (!force && shared?.key === key) return shared.promise
  const promise = listInstalmentPlans().then((r) => (r.kind === 'ok' ? r.value : null)).catch(() => null)
  shared = { key, promise }
  // A failed read is not kept: the next screen asks again rather than inheriting a blip.
  void promise.then((value) => {
    if (value === null && shared?.promise === promise) shared = null
  })
  return promise
}

/** Forget the shared read, so the next consumer asks again (after a Stop, or a logout). */
export function invalidateInstalmentPlans(): void {
  shared = null
}

export function useInstalmentPlans(buyerPubkey: string | undefined): {
  plans: InstalmentPlan[] | null
  reload: () => void
} {
  const [plans, setPlans] = useState<InstalmentPlan[] | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!buyerPubkey) {
      setPlans(null)
      return
    }
    let live = true
    load(buyerPubkey, tick > 0).then((value) => {
      if (live) setPlans(value)
    })
    return () => {
      live = false
    }
  }, [buyerPubkey, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { plans, reload }
}
