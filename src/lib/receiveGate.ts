/**
 * The gate every receive started by the user goes through (#331).
 *
 * dm-poll's redeems are counted and refused by its own adapter
 * (`countingInFlight` in dmPoll.ts). Cashback claims and gift links call
 * `TokenRedemption.redeem` directly, so logout's drain did not wait for them:
 * one already past the pacer at stop could save its coupon after the final
 * backup check, into the store the wipe then deleted.
 *
 * `beginReceive` is called BEFORE anything destructive (the cashback claim, the
 * gift link's first swap). Once logout has called `closeReceives`, it throws a
 * RECEIVE_DEFERRED error and nothing is spent: the link or claim stays where it
 * was, for the next try. A receive that got in first is counted until it ends,
 * and `drainReceives` waits for it. Check and count run with no `await` in
 * between, so a receive is either refused or counted.
 *
 * `drainTokenRedemptions` is the belt to that: it waits for every redeem the
 * legacy coordinator has in flight in this tab, whoever started it.
 */

let open = true
let inFlight = 0
const waiters = new Set<() => void>()

export const RECEIVE_DEFERRED = 'RECEIVE_DEFERRED'

export function isReceiveDeferred(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === RECEIVE_DEFERRED
}

/** Start a receive, or throw RECEIVE_DEFERRED when logout has closed the gate. Call the result when it ends. */
export function beginReceive(): () => void {
  if (!open) {
    throw Object.assign(new Error('receive deferred: logging out'), { code: RECEIVE_DEFERRED })
  }
  inFlight++
  let ended = false
  return () => {
    if (ended) return
    ended = true
    inFlight--
    if (inFlight === 0) for (const wake of [...waiters]) wake()
  }
}

/** Run `work` inside the gate. */
export async function withReceive<T>(work: () => Promise<T>): Promise<T> {
  const end = beginReceive()
  try {
    return await work()
  } finally {
    end()
  }
}

export function closeReceives(): void {
  open = false
}

export function openReceives(): void {
  open = true
}

export function receivesInFlight(): number {
  return inFlight
}

/** Resolve once no gated receive is running, or after `timeoutMs`. Whether it drained. Never throws. */
export function drainReceives(timeoutMs: number): Promise<boolean> {
  if (inFlight === 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      waiters.delete(wake)
      resolve(true)
    }
    const timer = setTimeout(() => {
      waiters.delete(wake)
      resolve(inFlight === 0)
    }, timeoutMs)
    waiters.add(wake)
  })
}

/** How many redeems the legacy coordinator has in flight in this tab (0 before it loads). */
export function tokenRedemptionsInFlight(): number {
  // No document at all (a worker, a node test): no coordinator can be running here.
  if (typeof window === 'undefined') return 0
  try {
    const tr = (window as { TokenRedemption?: { inFlightCount?: () => number } }).TokenRedemption
    const n = tr?.inFlightCount?.()
    return typeof n === 'number' && Number.isFinite(n) ? n : 0
  } catch {
    // Cannot tell: say "busy", the direction that keeps the money.
    return 1
  }
}

/** Resolve once the coordinator has nothing in flight, or after `timeoutMs`. Never throws. */
export async function drainTokenRedemptions(timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (tokenRedemptionsInFlight() > 0) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
  }
  return true
}
