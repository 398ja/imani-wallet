/**
 * @vitest-environment node
 *
 * #591 criterion 3: heartbeats at the server interval plus jitter, only while visible, with
 * exponential backoff on errors. Fake timers throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FleetScheduler, BACKOFF_BASE_MS } from '../scheduler'

function harness(opts: { random?: number; visible?: boolean; fail?: () => boolean } = {}) {
  let visible = opts.visible ?? true
  let listener: (() => void) | null = null
  const beats: number[] = []
  const s = new FleetScheduler({
    beat: vi.fn(async () => {
      beats.push(Date.now())
      if (opts.fail?.()) throw new Error('down')
      return { heartbeatSeconds: 900, jitterSeconds: 120 }
    }),
    random: () => opts.random ?? 0.5,
    visible: () => visible,
    onVisibility: (cb) => {
      listener = cb
      return () => void (listener = null)
    },
    now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  })
  return {
    s,
    beats,
    setVisible(v: boolean) {
      visible = v
      listener?.()
    },
    hasListener: () => listener !== null,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-11-10T23:00:00Z'))
})
afterEach(() => vi.useRealTimers())

describe('criterion 3: the heartbeat loop', () => {
  it('beats at once on start (unlock), then every heartbeat_seconds + jitter', async () => {
    const h = harness({ random: 0.5 })
    h.s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.beats.length).toBe(1)
    await vi.advanceTimersByTimeAsync(900_000 + 60_000 - 1)
    expect(h.beats.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.beats.length).toBe(2)
    expect(h.beats[1] - h.beats[0]).toBe(960_000)
  })

  it('jitter stays within [0, jitter_seconds]', async () => {
    for (const [r, gap] of [[0, 900_000], [0.999999, 900_000 + 119_999]] as const) {
      const h = harness({ random: r })
      h.s.start()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_100_000)
      expect(h.beats[1] - h.beats[0]).toBeGreaterThanOrEqual(900_000)
      expect(h.beats[1] - h.beats[0]).toBeLessThanOrEqual(1_020_000)
      expect(h.beats[1] - h.beats[0]).toBe(Math.floor(gap / 1) )
      h.s.stop()
    }
  })

  it('never beats while hidden; becoming visible beats only if one is due', async () => {
    const h = harness({ visible: false })
    h.s.start()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(h.beats.length).toBe(0)
    h.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.beats.length).toBe(1)
    // Hidden then visible again a minute later: not due, no beat.
    h.setVisible(false)
    await vi.advanceTimersByTimeAsync(60_000)
    h.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.beats.length).toBe(1)
    // Hidden across the due time: nothing fires while hidden.
    h.setVisible(false)
    await vi.advanceTimersByTimeAsync(2_000_000)
    expect(h.beats.length).toBe(1)
    h.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.beats.length).toBe(2)
  })

  it('backs off exponentially on errors, capped, and resets after a success', async () => {
    let failing = true
    const h = harness({ fail: () => failing })
    h.s.start()
    await vi.advanceTimersByTimeAsync(0)
    const gaps: number[] = []
    for (let i = 0; i < 8; i++) {
      const before = h.beats.length
      const t0 = Date.now()
      while (h.beats.length === before) await vi.advanceTimersByTimeAsync(1_000)
      gaps.push(Date.now() - t0)
    }
    expect(gaps[0]).toBeGreaterThanOrEqual(BACKOFF_BASE_MS * 2 - 1_000)
    for (let i = 1; i < 4; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1])
    // Never more often than the base, never longer than the cap (1 h).
    for (const g of gaps) expect(g).toBeLessThanOrEqual(3_600_000 + 1_000)
    expect(gaps[7]).toBeGreaterThanOrEqual(3_600_000 - 1_000)
    failing = false
    const before = h.beats.length
    while (h.beats.length === before) await vi.advanceTimersByTimeAsync(1_000)
    const t0 = Date.now()
    while (h.beats.length === before + 1) await vi.advanceTimersByTimeAsync(1_000)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900_000)
  })

  it('stop() (lock, logout, opt-out) ends the loop and the visibility listener', async () => {
    const h = harness()
    h.s.start()
    await vi.advanceTimersByTimeAsync(0)
    h.s.stop()
    expect(h.hasListener()).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * 3_600_000)
    expect(h.beats.length).toBe(1)
  })

  it('poke() (unlock) beats only when due, and never twice at once', async () => {
    const h = harness()
    h.s.start()
    h.s.poke()
    h.s.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.beats.length).toBe(1)
    h.s.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.beats.length).toBe(1)
  })
})
