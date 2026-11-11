import type { Timing } from './client'

/**
 * The heartbeat loop (#591 contract C6). Runs only between `start()` (opted in and unlocked) and
 * `stop()` (lock, logout, opt-out), and only beats while the document is visible: no background
 * check-ins (owner decision 6, option 0).
 *
 * - On start (unlock) and on becoming visible: beat if one is due.
 * - Otherwise every `heartbeat_seconds` plus a random jitter in [0, jitter_seconds).
 * - On an error: exponential backoff from 1 min, doubling, capped at 1 h. A success resets it.
 *
 * Timers, randomness, clock and visibility are injected so tests drive it with fake timers.
 */
export const BACKOFF_BASE_MS = 60_000
export const BACKOFF_MAX_MS = 3_600_000

export interface SchedulerDeps {
  /** One heartbeat (with any re-register and upload attempt). Resolves to the next timing. */
  beat: () => Promise<Timing>
  random: () => number
  visible: () => boolean
  /** Subscribe to visibility changes; returns an unsubscribe. */
  onVisibility: (cb: () => void) => () => void
  now: () => number
  setTimeout: (f: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
}

export class FleetScheduler {
  private running = false
  private timer: unknown = null
  private unsubscribe: (() => void) | null = null
  private dueAt = 0
  private failures = 0
  private inflight: Promise<void> | null = null

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.dueAt = this.deps.now()
    this.unsubscribe = this.deps.onVisibility(() => this.poke())
    this.poke()
  }

  stop(): void {
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer !== null) this.deps.clearTimeout(this.timer)
    this.timer = null
  }

  /** Resolves when no beat is running (tests and opt-in wait on the first beat). */
  idle(): Promise<void> {
    return this.inflight ?? Promise.resolve()
  }

  /** Beat now if one is due and the app is visible; otherwise make sure a timer is waiting. */
  poke(): void {
    if (!this.running || this.inflight) return
    if (!this.deps.visible()) {
      // Nothing fires while hidden; becoming visible pokes again.
      if (this.timer !== null) this.deps.clearTimeout(this.timer)
      this.timer = null
      return
    }
    const wait = this.dueAt - this.deps.now()
    if (wait > 0) {
      this.arm(wait)
      return
    }
    this.inflight = this.run().finally(() => {
      this.inflight = null
    })
  }

  private arm(ms: number): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer)
    this.timer = this.deps.setTimeout(() => {
      this.timer = null
      this.poke()
    }, Math.max(0, ms))
  }

  private async run(): Promise<void> {
    let next: number
    try {
      const t = await this.deps.beat()
      this.failures = 0
      const jitter = Math.floor(Math.min(0.999999, Math.max(0, this.deps.random())) * t.jitterSeconds * 1000)
      next = t.heartbeatSeconds * 1000 + jitter
    } catch {
      this.failures++
      next = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.failures)
    }
    if (!this.running) return
    this.dueAt = this.deps.now() + next
    if (this.deps.visible()) this.arm(next)
  }
}
