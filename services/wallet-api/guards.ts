/**
 * Replay refusal, idempotency, and per-key throttling.
 *
 * A signature proves who sent a request. It does not prove they meant to send
 * it twice. This service is about to be able to move money, so the difference
 * matters: a captured request replayed is a second spend, and a script that
 * retries after a timeout should not gamble on whether the first attempt
 * landed.
 *
 * Built BEFORE any endpoint that touches coupons, deliberately. Replay
 * protection retrofitted under a spending endpoint is replay protection nobody
 * trusts, because nobody can say what ran unprotected in between.
 *
 * ## Replay and idempotency are not the same mechanism
 *
 * They look similar and answer opposite questions.
 *
 * **Replay** asks "have I seen this exact signature before?" and REFUSES the
 * second appearance. It is a security control against an attacker resending a
 * captured request verbatim.
 *
 * **Idempotency** asks "have I already done this work for this caller?" and
 * REPLAYS the original answer. It is a correctness feature for an honest caller
 * whose network dropped a response.
 *
 * Collapsing them would break both. If a replayed signature returned the cached
 * answer, an attacker would learn what a captured request produced. If a
 * repeated idempotency key were refused, an honest retry would fail exactly
 * when it most needs to succeed — and the caller still would not know whether
 * the first attempt landed.
 *
 * The distinction shows up in the retry story: a correct retry uses a FRESH
 * signature (the old one is stale within a minute anyway) and the SAME
 * idempotency key. New signature, so not a replay; same key, so not repeated
 * work.
 */

import { createExpiringMap } from './expiringMap.js'
import { FRESHNESS_WINDOW_SECONDS } from './nip98.js'

/**
 * How long a signature is remembered.
 *
 * Exactly the window in which it could still verify: the freshness check
 * accepts 60 seconds either side of now, so a signature is dangerous for at
 * most 120 seconds. Held a little longer for clock jitter between the two
 * checks, and no longer — remembering beyond the point where `verifyNip98`
 * refuses it as stale would be memory spent on requests that are already
 * refused for another reason.
 *
 * This is the ticket's "not required to remember it any longer", and it falls
 * out of the window rather than being a number someone picked.
 */
export const REPLAY_TTL_MS = (FRESHNESS_WINDOW_SECONDS * 2 + 5) * 1000

/**
 * The most signatures remembered at once.
 *
 * At ~100 bytes an entry this is a few megabytes, which is the point: bounded
 * regardless of traffic. Sized far above any honest burst, so reaching it means
 * a flood rather than a busy afternoon.
 */
export const REPLAY_CAPACITY = 50_000

/** How long an idempotent answer is replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Idempotency records are capped well below replay records.
 *
 * They live 24 hours rather than two minutes and hold a whole response body, so
 * they are far more expensive per entry. A caller needing more than this many
 * distinct in-flight retries is not doing idempotency.
 */
export const IDEMPOTENCY_CAPACITY = 10_000

/** Requests allowed per key, per window. */
export const RATE_LIMIT = 120
export const RATE_WINDOW_MS = 60_000

/** A stored response, replayed verbatim for a repeated idempotency key. */
export interface StoredResponse {
  status: number
  body: unknown
}

export type GuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'replay'; detail: string }
  | { allowed: false; reason: 'at-capacity'; detail: string }
  | { allowed: false; reason: 'rate-limited'; detail: string; retryAfterSeconds: number }
  | { allowed: false; reason: 'idempotent-replay'; stored: StoredResponse }

export interface Guards {
  /**
   * Everything that must pass before a request does work.
   *
   * One call rather than three, because the ORDER is a decision and callers
   * should not each re-make it.
   */
  check(input: {
    /** The signed event id. Unique per signature, which is what makes it the replay key. */
    eventId: string
    /** The caller, which scopes throttling and idempotency. */
    pubkey: string
    /** The caller's `Idempotency-Key` header, if any. */
    idempotencyKey: string | undefined
    now: number
  }): GuardVerdict

  /** Store a response so a repeat of the same key can replay it. */
  remember(input: {
    pubkey: string
    idempotencyKey: string
    response: StoredResponse
    now: number
  }): void

  /** Counters, for the metrics endpoint. */
  readonly stats: {
    replaysRefused: number
    idempotentReplays: number
    throttled: number
    atCapacity: number
  }

  /** Live entry counts, so a test can prove the store is bounded. */
  sizes(now: number): { replay: number; idempotency: number; rate: number }

  clear(): void
}

/**
 * @param capacities  overridable ONLY so tests can fill a store. The real
 *   capacities are far too large to reach in a test, and the at-capacity branch
 *   is the security-critical one — it is what makes a flood a refusal rather
 *   than an accepted replay. Untestable safety code is not safety code.
 */
export function createGuards(
  capacities: { replay?: number; idempotency?: number } = {},
): Guards {
  const seen = createExpiringMap<true>(REPLAY_TTL_MS, capacities.replay ?? REPLAY_CAPACITY)
  const idempotent = createExpiringMap<StoredResponse>(
    IDEMPOTENCY_TTL_MS,
    capacities.idempotency ?? IDEMPOTENCY_CAPACITY,
  )

  /**
   * Throttling counts within a fixed window, keyed by pubkey.
   *
   * Per KEY, not per address, and that is the ticket's requirement for a real
   * reason: callers share NATs, VPNs and cloud egress ranges, so per-address
   * throttling makes one caller's retry loop another's outage. A key is the
   * only identity this service actually has.
   *
   * Per-address shedding still belongs at the edge, where a flood can be
   * dropped before it costs a signature verification. These are layers, not
   * alternatives.
   */
  const rate = createExpiringMap<{ count: number; windowEnds: number }>(
    RATE_WINDOW_MS,
    IDEMPOTENCY_CAPACITY,
  )

  const stats = { replaysRefused: 0, idempotentReplays: 0, throttled: 0, atCapacity: 0 }

  return {
    stats,

    check({ eventId, pubkey, idempotencyKey, now }) {
      // Throttling FIRST, because it is the cheapest check and the one that
      // protects the others. A caller in a hot loop should be shed before it
      // can fill the replay store — otherwise a flood that is refused is still
      // a flood that consumed capacity.
      const window = rate.get(pubkey, now)
      if (window) {
        if (window.count >= RATE_LIMIT) {
          stats.throttled++
          const retryAfterSeconds = Math.max(1, Math.ceil((window.windowEnds - now) / 1000))
          return {
            allowed: false,
            reason: 'rate-limited',
            // Says how long, because "you are throttled" without a duration
            // invites exactly the hammering it is trying to stop.
            detail:
              `more than ${RATE_LIMIT} requests in ${RATE_WINDOW_MS / 1000}s from this key. ` +
              `Retry in ${retryAfterSeconds}s.`,
            retryAfterSeconds,
          }
        }
        window.count++
      } else {
        rate.set(pubkey, { count: 1, windowEnds: now + RATE_WINDOW_MS }, now)
      }

      // Idempotency BEFORE replay. A correct retry carries a fresh signature,
      // so it is not a replay and the order rarely matters — but a caller that
      // retries fast enough to reuse a signature should get its cached answer
      // rather than a confusing replay refusal for a request it is entitled to
      // repeat.
      if (idempotencyKey !== undefined) {
        // Scoped to the caller. An unscoped key would let one caller's choice
        // of "retry-1" serve another caller's response — a cross-caller data
        // leak dressed as a convenience feature.
        const stored = idempotent.get(idempotencyScope(pubkey, idempotencyKey), now)
        if (stored) {
          stats.idempotentReplays++
          return { allowed: false, reason: 'idempotent-replay', stored }
        }
      }

      const outcome = seen.set(eventId, true, now)
      if (outcome === 'duplicate') {
        stats.replaysRefused++
        return {
          allowed: false,
          reason: 'replay',
          detail:
            'this exact signed request has already been seen. Sign a fresh request; ' +
            'to retry safely, reuse your Idempotency-Key with a new signature.',
        }
      }
      if (outcome === 'at-capacity') {
        // Fail CLOSED. Evicting a live entry to make room is precisely the hole
        // that count-only eviction opens, so the service refuses instead. A
        // caller retrying in a minute beats a spend that happens twice.
        stats.atCapacity++
        return {
          allowed: false,
          reason: 'at-capacity',
          detail: 'the service is shedding load and cannot guarantee replay protection. Retry shortly.',
        }
      }

      return { allowed: true }
    },

    remember({ pubkey, idempotencyKey, response, now }) {
      idempotent.set(idempotencyScope(pubkey, idempotencyKey), response, now)
    },

    sizes(now) {
      return { replay: seen.size(now), idempotency: idempotent.size(now), rate: rate.size(now) }
    },

    clear() {
      seen.clear()
      idempotent.clear()
      rate.clear()
      stats.replaysRefused = 0
      stats.idempotentReplays = 0
      stats.throttled = 0
      stats.atCapacity = 0
    },
  }
}

/**
 * The storage key for one caller's idempotency key.
 *
 * A NUL separator, not a colon or a dash: a pubkey is fixed-length hex so it
 * cannot contain one, and a caller-chosen key cannot introduce one through
 * JSON. Any printable separator could be smuggled inside a caller's own key to
 * collide with another caller's scope.
 */
function idempotencyScope(pubkey: string, key: string): string {
  return `${pubkey.toLowerCase()}\u0000${key}`
}
