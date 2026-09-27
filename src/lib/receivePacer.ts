/**
 * Pacing redemptions under the gateway's per-pubkey budget (#110).
 *
 * `/api/v1/wallet/receive*` is limited to 10 calls a minute per pubkey, and a
 * redemption is not one call: it is the receive and its ack, and for a coupon
 * the merchant issued, a second receive and ack for the burn. An 8-part bundle
 * fired all at once is 16 to 32 calls against a budget of 10. Staging logged 16
 * `path_rate_limit_exceeded` for one such bundle, the parts landed up to 4½
 * minutes late, and five acks were dropped on the floor.
 *
 * `RATE_LIMIT_BACKOFFS_MS` and `retryOnTransientMintError` in dmPoll recover
 * from a 429 once it has happened. This keeps it from happening: at most
 * `REDEMPTIONS_PER_WINDOW` redemptions START in any rolling `WINDOW_MS`, and the
 * rest wait their turn. The 429 retry stays underneath as the backstop for
 * whatever else shares the budget (another tab, a manual receive).
 *
 * Four per minute: a redemption is a receive and an ack, so four is 8 of the
 * 10 calls, leaving 2 for the burn a merchant's own coupon triggers (burn.ts
 * retries a throttled burn, and the login sweep catches one that still
 * failed). It costs nothing for the ordinary single coupon: the first four in a
 * window go straight through.
 *
 * Per account and in memory. A reload loses the window, which is fine: the
 * gateway's own window is what the limiter enforces, and the 429 backstop
 * covers the seam.
 */

export const REDEMPTIONS_PER_WINDOW = 4
export const WINDOW_MS = 60_000

/**
 * The largest bundle whose last part must still arrive inside the #94 wait
 * window. Staging's biggest was 8; this leaves headroom for a larger one.
 */
export const PACED_BUNDLE_PARTS = 12

/**
 * How long the LAST part of an `parts`-part bundle can wait for a pacing slot,
 * before its own receive even starts. `bundleArrival.test.ts` pins the bundle
 * wait window above this plus the 429 retry budget.
 */
export function worstCasePacingDelayMs(parts: number): number {
  if (parts <= REDEMPTIONS_PER_WINDOW) return 0
  return Math.ceil(parts / REDEMPTIONS_PER_WINDOW - 1) * WINDOW_MS
}

type Sleep = (ms: number) => Promise<void>

export interface ReceivePacer {
  /** Resolves when a redemption may start, and books its slot. Never throws. */
  acquire(): Promise<void>
  reset(): void
}

export function createReceivePacer(opts: {
  limit?: number
  windowMs?: number
  now?: () => number
  sleep?: Sleep
} = {}): ReceivePacer {
  const limit = opts.limit ?? REDEMPTIONS_PER_WINDOW
  const windowMs = opts.windowMs ?? WINDOW_MS
  const now = opts.now ?? (() => Date.now())
  const sleep: Sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let starts: number[] = []
  // A promise chain, so waiters are served in arrival order and two callers
  // woken together cannot both take the last slot.
  let queue: Promise<void> = Promise.resolve()

  async function take(): Promise<void> {
    for (;;) {
      const t = now()
      starts = starts.filter((s) => t - s < windowMs)
      if (starts.length < limit) {
        starts.push(t)
        return
      }
      await sleep(starts[0] + windowMs - t)
    }
  }

  return {
    acquire() {
      const turn = queue.then(take, take)
      queue = turn.catch(() => undefined)
      return turn.catch(() => undefined)
    },
    reset() {
      starts = []
      queue = Promise.resolve()
    },
  }
}
