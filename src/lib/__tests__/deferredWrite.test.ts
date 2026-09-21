/**
 * Coalescing localStorage writes so a catch-up does not freeze the page.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  cancelDeferredWrite,
  cancelDeferredWrites,
  deferWrite,
  flushDeferredWrites,
} from '../deferredWrite'

describe('deferred writes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    cancelDeferredWrites()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses a burst of writes into one', () => {
    const write = vi.fn()

    // What a catch-up looks like: one call per event processed.
    for (let i = 0; i < 2000; i += 1) deferWrite('k', write)

    // Nothing has touched storage yet, which is the point -- the loop above
    // ran without a single synchronous serialisation between it and a frame.
    expect(write).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('persists the NEWEST state, not the first queued', () => {
    const seen: number[] = []
    for (const value of [1, 2, 3]) deferWrite('k', () => seen.push(value))

    vi.runAllTimers()

    // A coalescing writer that kept the first callback would persist a value
    // that was stale before it landed.
    expect(seen).toEqual([3])
  })

  it('keeps separate keys separate', () => {
    const a = vi.fn()
    const b = vi.fn()
    deferWrite('a', a)
    deferWrite('b', b)

    vi.runAllTimers()

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('flushes when the page is hidden', () => {
    const write = vi.fn()
    deferWrite('k', write)

    // The last moment anything runs on mobile: a PWA is killed, not closed,
    // so a pending write that waited for a timer would simply be lost.
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(write).toHaveBeenCalledTimes(1)

    // And it does not then run a second time when the timer fires.
    vi.runAllTimers()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('lets a caller cancel a write it is about to invalidate', () => {
    const write = vi.fn()
    deferWrite('k', write)

    // The sign-out and amnesty case: the queued write would put back exactly
    // the data the caller is removing.
    cancelDeferredWrite('k')
    vi.runAllTimers()

    expect(write).not.toHaveBeenCalled()
  })

  it('survives a write that throws', () => {
    const boom = vi.fn(() => {
      throw new Error('quota exceeded')
    })
    deferWrite('a', boom)

    // A throwing write must not leave the entry queued forever, nor take down
    // the timer. Storage failures are expected: quota, private browsing.
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(boom).toHaveBeenCalledTimes(1)

    const after = vi.fn()
    deferWrite('a', after)
    vi.runAllTimers()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('flushDeferredWrites is safe with nothing queued', () => {
    expect(() => flushDeferredWrites()).not.toThrow()
  })

  it('does not leak a timer when a cancel is followed by a requeue', () => {
    deferWrite('k', () => {})
    cancelDeferredWrite('k')
    deferWrite('k', () => {})

    // One key, one timer. Inferring "has a live timer" from "has a queued
    // write" got this wrong, because a cancel empties the queue while its
    // timer is still pending: the requeue then started a SECOND timer. It
    // fires into an empty queue and does no damage, but nothing clears it,
    // and sign-out and the amnesty both cancel -- so it accrues on exactly
    // the paths that repeat.
    expect(vi.getTimerCount()).toBe(1)
  })

  it('cancelling clears the timer rather than leaving it to fire', () => {
    deferWrite('k', () => {})
    cancelDeferredWrite('k')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('flushing clears the timers it has just satisfied', () => {
    deferWrite('a', () => {})
    deferWrite('b', () => {})
    flushDeferredWrites()

    // Left pending, these would keep both keys looking "covered", so the next
    // deferWrite for either would never start a timer and its write would sit
    // in the queue until something else happened to flush it.
    expect(vi.getTimerCount()).toBe(0)

    const after = vi.fn()
    deferWrite('a', after)
    vi.runAllTimers()
    expect(after).toHaveBeenCalledTimes(1)
  })
})
