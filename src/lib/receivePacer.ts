/**
 * Pacing calls to `/api/v1/wallet/receive*` under the gateway's per-pubkey
 * budget (#110).
 *
 * The gateway allows 10 calls a minute per pubkey on `/wallet/receive*`, and
 * the ack counts against the same budget as the receive. A redemption is a
 * receive plus its ack (2 calls). A coupon the merchant issued is then burnt,
 * which is another receive and ack (2 more, so 4 per part). Staging's 8-part
 * self-issued bundle was 32 calls fired at once against a budget of 10. It drew
 * 16 `path_rate_limit_exceeded`, parts landed up to 4½ minutes late, and five
 * acks were dropped.
 *
 * So this paces CALLS, not parts (review of #111: pacing parts at 4 a minute
 * let a self-issued bundle spend 16 calls a minute). At most
 * `CALLS_PER_WINDOW` calls start in any rolling `WINDOW_MS`. That is 8 of the
 * gateway's 10, leaving 2 for what cannot be paced here (another tab, a manual
 * receive). Every spender reserves before it calls:
 *   - dmPoll: 2 per receive ATTEMPT (receive + its ack), inside the 429 retry,
 *     so retries are paced too;
 *   - burn.ts: 2 per burn attempt;
 *   - tokenRedemption's background ack retry and startup/catch-up flush: 1
 *     per ack (through `TokenRedemption._ackGate`).
 * The 429 retry (`RATE_LIMIT_BACKOFFS_MS`) stays underneath as the backstop.
 *
 * One pacer per page, because the budget is per pubkey and a page serves one
 * account at a time. `stopDmPoll` resets it on logout or account switch.
 */

export const CALLS_PER_WINDOW = 8
export const WINDOW_MS = 60_000

/** Calls one redemption attempt reserves: the receive and its ack. */
export const CALLS_PER_REDEEM = 2
/** Calls one burn attempt reserves: its receive and its ack. */
export const CALLS_PER_BURN = 2
/** Calls one ack reserves. */
export const CALLS_PER_ACK = 1

/**
 * The bundle size the #94 wait window is sized for. Staging's largest was 8
 * parts, and the gateway's send path produced no bigger bundle in the logs.
 */
export const PACED_BUNDLE_PARTS = 8

/**
 * A conservative bound on how long the pacer can hold back the LAST part of
 * a `parts`-part bundle before its first receive may start.
 *
 * It does NOT assume an empty window. Everything that can be queued ahead of
 * that part is counted, at the worst case for each:
 *   - every part redeemed AND burnt (self-issued): (2 + 2) calls each;
 *   - every part's first ack failing, so each gets one background ack retry
 *     (1 call each);
 *   - one startup/catch-up flush at its per-run cap (2 calls);
 *   - the window already full when the bundle arrives (CALLS_PER_WINDOW).
 * `bundleArrival.test.ts` requires the bundle wait window to exceed this PLUS
 * the full 429 retry budget, so a part still waiting its turn is never called
 * missing.
 */
export function worstCasePacingDelayMs(parts: number): number {
  const calls =
    CALLS_PER_WINDOW + parts * (CALLS_PER_REDEEM + CALLS_PER_BURN + CALLS_PER_ACK) + 2
  return Math.ceil(calls / CALLS_PER_WINDOW) * WINDOW_MS
}

type Sleep = (ms: number) => Promise<void>

export interface ReceivePacer {
  /**
   * Resolves when `calls` more calls fit in the window, and books them.
   * Never throws. Waiters are served in arrival order.
   */
  acquire(calls?: number): Promise<void>
  reset(): void
}

export function createReceivePacer(opts: {
  limit?: number
  windowMs?: number
  now?: () => number
  sleep?: Sleep
} = {}): ReceivePacer {
  const limit = opts.limit ?? CALLS_PER_WINDOW
  const windowMs = opts.windowMs ?? WINDOW_MS
  const now = opts.now ?? (() => Date.now())
  const sleep: Sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let starts: number[] = []
  let queue: Promise<void> = Promise.resolve()

  async function take(calls: number): Promise<void> {
    // A reservation larger than the window can never fit; clamp it so it
    // waits for an empty window rather than forever.
    const need = Math.max(1, Math.min(calls, limit))
    for (;;) {
      const t = now()
      starts = starts.filter((s) => t - s < windowMs)
      if (starts.length + need <= limit) {
        for (let i = 0; i < need; i++) starts.push(t)
        return
      }
      // Wait until enough of the oldest calls have aged out.
      const freeAt = starts[starts.length + need - limit - 1] + windowMs
      await sleep(Math.max(1, freeAt - t))
    }
  }

  return {
    acquire(calls = 1) {
      const turn = queue.then(() => take(calls), () => take(calls))
      queue = turn.catch(() => undefined)
      return turn.catch(() => undefined)
    },
    reset() {
      starts = []
      queue = Promise.resolve()
    },
  }
}

let shared: ReceivePacer = createReceivePacer()

/** The page's pacer: dmPoll, burn.ts and the ack retry all spend from it. */
export function receivePacer(): ReceivePacer {
  return shared
}

/**
 * Swap the page's pacer. For tests that push many redemptions through the
 * adapter to exercise something else, where real pacing would turn a loop into
 * minutes of wall-clock waiting. Returns the previous one.
 */
export function _setReceivePacerForTests(pacer: ReceivePacer): ReceivePacer {
  const previous = shared
  shared = pacer
  return previous
}
