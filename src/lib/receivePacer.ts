/**
 * Pacing calls to `/api/v1/wallet/receive*` under the gateway's per-pubkey
 * budget (#110).
 *
 * The gateway allows 10 calls a minute per pubkey on `/wallet/receive*`. Before
 * imani-gateway-customer#120 the ack counted against the same budget. A redemption is a
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
 *   - tokenRedemption: 1 per api.receive (`_receiveGate`, so every retry
 *     layer is paced), installed by dmPoll;
 *   - burn.ts: 1 per burn attempt (its receive).
 * Acks are NOT paced: since imani-gateway-customer#120 the POST ack path is
 * exempt from the limit, so pacing them only delayed receives (#111 delta
 * review). tokenRedemption's `_ackGate` hook stays, a no-op by default.
 * The 429 retry (`RATE_LIMIT_BACKOFFS_MS`) stays underneath as the backstop.
 *
 * One pacer per page, because the budget is per pubkey and a page serves one
 * account at a time. `stopDmPoll` resets it on logout or account switch.
 */

export const CALLS_PER_WINDOW = 8
export const WINDOW_MS = 60_000

/** One `/wallet/receive` call: what each api.receive reserves (tokenRedemption's receive gate). */
export const CALLS_PER_RECEIVE = 1
/** Calls one burn attempt reserves in burn.ts: its receive (the ack is exempt, #120). */
export const CALLS_PER_BURN = 1

/**
 * Hard ceiling on api.receive calls for one token across EVERY retry layer
 * (inner transient retry, 409 in-flight wait, dmPoll's outer 429 retry).
 * Enforced in shared/tokenRedemption.js as RECEIVE_CALLS_PER_TOKEN; a test pins
 * the two equal, because this bound is only honest while that cap holds.
 */
export const MAX_RECEIVE_CALLS_PER_TOKEN = 5
/** burn.ts: one attempt plus its single 409/429 retry. */
export const MAX_BURN_CALLS_PER_PART = 2 * CALLS_PER_BURN

/**
 * Every sleep a part's own retries can add on top of waiting for the pacer:
 * dmPoll's RATE_LIMIT_BACKOFFS_MS (155 s), dm-poll's transient backoffs
 * (1 + 4 + 15 s) and two 409 in-flight waits (5 s cap each). Kept here as a
 * plain number so this module stays free of dmPoll's imports; the bundle test
 * recomputes it from the real RATE_LIMIT_BACKOFFS_MS.
 */
export const RETRY_SLEEP_BUDGET_MS = 155_000 + 20_000 + 2 * 5_000

/** Slack on top of the bound: clock skew, slow responses, timer drift. */
export const PACING_MARGIN_MS = 2 * WINDOW_MS

/**
 * The bundle size the #94 wait window is sized for. Staging's largest was 8
 * parts, and the gateway's send path produced no bigger bundle in the logs.
 */
export const PACED_BUNDLE_PARTS = 8

/**
 * A conservative bound on how long the LAST part of a `parts`-part bundle can
 * take, from the bundle's arrival, to finish every call it may make.
 *
 * Counts every call that goes through the pacer, at its maximum, for every
 * part ahead of it and itself (#110 second review C):
 *   - the window already full when the bundle arrives: CALLS_PER_WINDOW;
 *   - per part: every receive the per-token cap allows (5) and a burn with
 *     its retry (2): 7 calls. Acks are exempt from the limit (#120) and are
 *     not paced.
 * The per-token cap's span (RECEIVE_CALLS_SPAN_MS in tokenRedemption) is at
 * least the wait window, so a token cannot spend its cap twice inside it.
 * Then adds every retry sleep and a margin. `bundleArrival.test.ts` pins
 * BUNDLE_WAIT_WINDOW_MS above this.
 */
export function worstCaseBundleMs(parts: number): number {
  const perPart = MAX_RECEIVE_CALLS_PER_TOKEN + MAX_BURN_CALLS_PER_PART
  const calls = CALLS_PER_WINDOW + parts * perPart
  const windows = Math.ceil(calls / CALLS_PER_WINDOW)
  return windows * WINDOW_MS + RETRY_SLEEP_BUDGET_MS + PACING_MARGIN_MS
}

type Sleep = (ms: number) => Promise<void>

/** A waiter the pacer dropped because it was reset (logout / account switch). */
export class PacerResetError extends Error {
  /** Shared with tokenRedemption's budget deferral: a quiet, retryable non-success. */
  readonly code = 'RECEIVE_DEFERRED'
  constructor() {
    super('receive pacer was reset; the waiting call belongs to the previous session')
    this.name = 'PacerResetError'
  }
}

export interface ReceivePacer {
  /**
   * Resolves when `calls` more calls fit in the window, and books them.
   * Waiters are served in arrival order. Rejects ONLY with PacerResetError,
   * when `reset()` runs while it waits: a call queued for the previous account
   * must never go out under the next one's session.
   */
  acquire(calls?: number): Promise<void>
  /** Empty the window and settle every waiter with PacerResetError. */
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
  let generation = 0
  // Resolved by reset(), so a waiter mid-sleep wakes at once instead of
  // finishing its sleep and firing a call for the previous account.
  let wake: () => void = () => {}
  let resetSignal = new Promise<void>((r) => (wake = r))

  async function take(calls: number, gen: number): Promise<void> {
    const need = Math.max(1, Math.min(calls, limit))
    for (;;) {
      if (gen !== generation) throw new PacerResetError()
      const t = now()
      starts = starts.filter((s) => t - s < windowMs)
      if (starts.length + need <= limit) {
        for (let i = 0; i < need; i++) starts.push(t)
        return
      }
      const freeAt = starts[starts.length + need - limit - 1] + windowMs
      await Promise.race([sleep(Math.max(1, freeAt - t)), resetSignal])
    }
  }

  return {
    acquire(calls = 1) {
      const gen = generation
      const turn = queue.then(() => take(calls, gen), () => take(calls, gen))
      queue = turn.catch(() => undefined)
      return turn
    },
    reset() {
      generation += 1
      starts = []
      queue = Promise.resolve()
      wake()
      resetSignal = new Promise<void>((r) => (wake = r))
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
