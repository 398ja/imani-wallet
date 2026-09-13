/**
 * @vitest-environment jsdom
 *
 * jsdom because the watcher listens for `visibilitychange` on `document` — that
 * listener is not incidental, it is the half of the module that catches a
 * deadline slept through in a backgrounded tab, and a node environment cannot
 * exercise it.
 *
 * The expiry watcher, driven on a fake clock.
 *
 * What these assert is the behaviour a plain `setTimeout` would not give: that
 * the lapse fires ONCE rather than on every tick past the deadline, that a
 * renewed session re-arms it, and that a deadline slept through in a background
 * tab is caught on return rather than whenever a throttled timer gets around to
 * it. Those three are the whole reason this module is not two lines inline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { watchSessionExpiry } from '../sessionExpiry'

/** Unix SECONDS, the unit `SessionState.expiresAt` carries. */
const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

describe('watchSessionExpiry', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it('does not fire while the session is still live', () => {
    const onExpired = vi.fn()
    stop = watchSessionExpiry({ getExpiresAt: () => NOW_S + 600, onExpired })

    vi.advanceTimersByTime(500_000)

    expect(onExpired).not.toHaveBeenCalled()
  })

  it('fires when the deadline passes', () => {
    const onExpired = vi.fn()
    stop = watchSessionExpiry({ getExpiresAt: () => NOW_S + 600, onExpired })

    vi.advanceTimersByTime(600_000)

    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('fires EARLY by the grace period, so a request in flight cannot lose the race', () => {
    const onExpired = vi.fn()
    stop = watchSessionExpiry({
      getExpiresAt: () => NOW_S + 600,
      onExpired,
      graceMs: 30_000,
    })

    // 30s before the server's own deadline.
    vi.advanceTimersByTime(570_000)

    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('fires only ONCE, so the dialog is not reopened under the user', () => {
    const onExpired = vi.fn()
    stop = watchSessionExpiry({ getExpiresAt: () => NOW_S + 60, onExpired })

    // Long past the deadline, with the session still reporting the same stale
    // expiry — which is exactly what happens while the user types a passphrase.
    vi.advanceTimersByTime(600_000)

    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('re-arms once a fresh session moves the deadline forward', () => {
    const onExpired = vi.fn()
    const onRenewed = vi.fn()
    let expiresAt = NOW_S + 60
    stop = watchSessionExpiry({ getExpiresAt: () => expiresAt, onExpired, onRenewed })

    vi.advanceTimersByTime(60_000)
    expect(onExpired).toHaveBeenCalledTimes(1)

    // The user re-authenticated: the new session runs an hour from now.
    expiresAt = NOW_S + 60 + 3600
    vi.advanceTimersByTime(2_000)
    expect(onExpired).toHaveBeenCalledTimes(1)
    // Reported, so the prompt can close itself. The watcher fires EARLY, while
    // nap still considers the session live, so a renewal in that window never
    // flips `isAuthenticated` and nothing else would ever close the dialog.
    expect(onRenewed).toHaveBeenCalledTimes(1)

    // And the NEXT lapse is caught too — the latch released rather than
    // permanently disarming the watcher.
    vi.advanceTimersByTime(3_600_000)
    expect(onExpired).toHaveBeenCalledTimes(2)
  })

  it('does not report a renewal when nothing had lapsed', () => {
    const onRenewed = vi.fn()
    let expiresAt = NOW_S + 600
    stop = watchSessionExpiry({
      getExpiresAt: () => expiresAt,
      onExpired: vi.fn(),
      onRenewed,
    })

    // A session renewed early, before it ever lapsed. There was no prompt to
    // close, and firing here would be a transition that did not happen.
    expiresAt = NOW_S + 7200
    vi.advanceTimersByTime(300_000)

    expect(onRenewed).not.toHaveBeenCalled()
  })

  it('idles rather than firing when there is no session to watch', () => {
    const onExpired = vi.fn()
    stop = watchSessionExpiry({ getExpiresAt: () => null, onExpired })

    vi.advanceTimersByTime(600_000)

    // "No deadline" is not "expired". Firing here would put a passphrase dialog
    // over a login that has not finished yet.
    expect(onExpired).not.toHaveBeenCalled()
  })

  it('picks up a session established after the watcher started', () => {
    const onExpired = vi.fn()
    let expiresAt: number | null = null
    stop = watchSessionExpiry({ getExpiresAt: () => expiresAt, onExpired })

    vi.advanceTimersByTime(5_000)
    expect(onExpired).not.toHaveBeenCalled()

    // The login landed.
    expiresAt = NOW_S + 5 + 60
    vi.advanceTimersByTime(61_000)

    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('catches a deadline slept through in a background tab, on return', () => {
    const onExpired = vi.fn()
    stop = watchSessionExpiry({ getExpiresAt: () => NOW_S + 600, onExpired })

    // The tab is hidden and its timers are throttled: the clock moves past the
    // deadline without the scheduled callback running. `setSystemTime` moves
    // `Date.now` without advancing the timer queue, which is exactly that.
    vi.setSystemTime(NOW_MS + 900_000)
    expect(onExpired).not.toHaveBeenCalled()

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(onExpired).toHaveBeenCalledTimes(1)
  })

  it('stops cleanly, and stopping twice is safe', () => {
    const onExpired = vi.fn()
    const cancel = watchSessionExpiry({ getExpiresAt: () => NOW_S + 60, onExpired })

    cancel()
    cancel()
    vi.advanceTimersByTime(600_000)

    expect(onExpired).not.toHaveBeenCalled()
  })
})
