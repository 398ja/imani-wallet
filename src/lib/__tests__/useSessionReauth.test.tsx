/**
 * @vitest-environment jsdom
 *
 * When the app decides to ask for the passphrase again.
 *
 * These are the cases that never show up in a screenshot and each of which has
 * a failure mode worse than the bug being fixed: a dialog over a login that is
 * still in progress, a dialog that outlives the session it was asking about, or
 * — the original bug — no dialog at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { useSessionReauth } from '../useSessionReauth'

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000

/** A stand-in for the bits of NapSession the hook reads. */
function fakeSession(expiresAt: number | null) {
  let current = expiresAt
  return {
    getSession: () => (current === null ? null : { expiresAt: current }),
    renew: (seconds: number) => {
      current = seconds
    },
  }
}

function Probe({
  session,
  isAuthenticated,
}: {
  session: { getSession: () => { expiresAt: number } | null }
  isAuthenticated: boolean
}) {
  const { expired, dismiss } = useSessionReauth(session as never, isAuthenticated)
  // Exposed as a button rather than assigned to a module global during render,
  // which `react-hooks/globals` rightly refuses. `dismiss` is not a user gesture
  // in the app — `Gate` calls it when `reauthenticate()` resolves — so the button
  // is a test handle, not a claim about the UI.
  return (
    <>
      <span data-testid="state">{expired ? 'prompting' : 'quiet'}</span>
      <button data-testid="dismiss" onClick={dismiss} />
    </>
  )
}

const state = () => screen.getByTestId('state').textContent
const dismissLatest = () => fireEvent.click(screen.getByTestId('dismiss'))

/**
 * Stand in for the gateway's `/api/v1/auth/validate`.
 *
 * That endpoint is the authority on the sliding idle window: it answers 200
 * with a deadline it has just pushed forward, or 401 once the session is
 * genuinely over. The hook asks it before showing the dialog, so what it
 * returns here decides whether the user is interrupted.
 */
function stubValidate(
  answer:
    | { expired: true }
    | { unreachable: true }
    | { slidTo: number },
) {
  const fetchMock = vi.fn(async () => {
    if ('unreachable' in answer) throw new TypeError('Failed to fetch')
    if ('expired' in answer) {
      return new Response(JSON.stringify({ error: 'session_ended', reason: 'expired' }), {
        status: 401,
      })
    }
    return new Response(JSON.stringify({ status: 'ok', expires_at: answer.slidTo }), {
      status: 200,
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Let a validate promise resolve while the clock is frozen.
 *
 * `advanceTimersByTime` does not yield to the microtask queue, and the hook's
 * decision arrives one `await` after the timer fires. Without this the
 * assertion runs before the server's answer has been applied.
 */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useSessionReauth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    // The hook confirms a suspected lapse against `/auth/validate` before it
    // interrupts anyone, so every test needs an answer from it. The default is
    // "the server agrees the session is over", which is the case the original
    // tests were written against.
    stubValidate({ expired: true })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stays quiet while the session is live', () => {
    render(<Probe session={fakeSession(NOW_S + 3600)} isAuthenticated />)

    act(() => {
      vi.advanceTimersByTime(600_000)
    })

    expect(state()).toBe('quiet')
  })

  it('prompts when the session lapses under an open app', async () => {
    render(<Probe session={fakeSession(NOW_S + 600)} isAuthenticated />)
    expect(state()).toBe('quiet')

    act(() => {
      vi.advanceTimersByTime(600_000)
    })
    await settle()

    // The bug. Before this, the clock ran out and nothing on screen changed
    // until the user made a request and hit a wall.
    expect(state()).toBe('prompting')
  })

  it('does NOT prompt during the initial sign-in', () => {
    // `isAuthenticated` is false here because login has not resolved yet, not
    // because anything expired. Prompting would put a passphrase box over a
    // sign-in that is already succeeding.
    render(<Probe session={fakeSession(null)} isAuthenticated={false} />)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(state()).toBe('quiet')
  })

  it('prompts when the session is lost for a reason other than the clock', () => {
    const session = fakeSession(NOW_S + 3600)
    const { rerender } = render(<Probe session={session} isAuthenticated />)
    expect(state()).toBe('quiet')

    // A rejected or dropped cookie: the deadline is still in the future, but the
    // session is gone. Only the reactive half can catch this.
    rerender(<Probe session={session} isAuthenticated={false} />)

    expect(state()).toBe('prompting')
  })

  it('closes itself when authentication comes back', () => {
    const session = fakeSession(NOW_S + 3600)
    const { rerender } = render(<Probe session={session} isAuthenticated />)
    rerender(<Probe session={session} isAuthenticated={false} />)
    expect(state()).toBe('prompting')

    // Another tab re-authenticated and nap broadcast it. Leaving the dialog up
    // would ask the user to unlock a session that is already open.
    rerender(<Probe session={session} isAuthenticated />)

    expect(state()).toBe('quiet')
  })

  it('re-arms for the NEXT lapse after a renewal', async () => {
    const session = fakeSession(NOW_S + 600)
    const { rerender } = render(<Probe session={session} isAuthenticated />)

    act(() => {
      vi.advanceTimersByTime(600_000)
    })
    await settle()
    expect(state()).toBe('prompting')

    // The user unlocked: a fresh session, an hour out.
    act(() => {
      session.renew(NOW_S + 600 + 3600)
    })
    rerender(<Probe session={session} isAuthenticated />)
    // Within a second, not instantly: while lapsed the watcher re-checks the
    // deadline once a second, and that tick is what notices the renewal. The
    // dialog's own submit path calls `dismiss()` directly, so a user unlocking
    // here sees it close immediately — this tick is the OTHER route, for a
    // renewal that arrived from another tab.
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(state()).toBe('quiet')

    act(() => {
      vi.advanceTimersByTime(3_600_000)
    })
    await settle()

    // A watcher that latched permanently would leave the second lapse silent —
    // the original bug, returning after one successful unlock.
    expect(state()).toBe('prompting')
  })

  /**
   * The dismissal must not outlive the lapse it was made in.
   *
   * `dismiss()` exists to close the dialog the instant a correct passphrase
   * lands, rather than waiting on NapProvider's 500ms poll — so it is called
   * while `isAuthenticated` is still briefly false. The risk is that the same
   * suppression then swallows a LATER, genuine loss, which would put the user
   * back on the dead screen this whole change exists to remove.
   */
  describe('a dismissal', () => {
    it('covers the gap between a correct passphrase and the session catching up', () => {
      const session = fakeSession(NOW_S + 3600)
      const { rerender } = render(<Probe session={session} isAuthenticated />)
      rerender(<Probe session={session} isAuthenticated={false} />)
      expect(state()).toBe('prompting')

      // The dialog's submit resolved and called dismiss(), but the provider has
      // not yet polled the session, so `isAuthenticated` is still false. The
      // dialog must already be gone.
      act(() => {
        dismissLatest()
      })

      expect(state()).toBe('quiet')
    })

    it('does NOT silence a later, genuine session loss', () => {
      const session = fakeSession(NOW_S + 3600)
      const { rerender } = render(<Probe session={session} isAuthenticated />)

      // Lapse, unlock, dismiss.
      rerender(<Probe session={session} isAuthenticated={false} />)
      act(() => {
        dismissLatest()
      })
      expect(state()).toBe('quiet')

      // The session really did come back.
      rerender(<Probe session={session} isAuthenticated />)
      expect(state()).toBe('quiet')

      // And now it is lost again — a revoked cookie, whose deadline has not
      // arrived, so the timer will not catch it. A dismissal that outlived its
      // own lapse would leave this silent and the app back on the dead screen.
      rerender(<Probe session={session} isAuthenticated={false} />)

      expect(state()).toBe('prompting')
    })
  })

  /**
   * The reported bug: "the popup appears every 15 minutes irrespective of
   * activity, interrupting users in the middle of using the app."
   *
   * The cause was not the length of the timeout. The gateway runs a SLIDING
   * idle window — `/api/v1/auth/validate` pushes `expires_at` out to
   * `now + 15min` on every authenticated request — but the client only ever
   * learned `expiresAt` once, in the login response. So the local watcher
   * counted down from a snapshot that active use had long since invalidated,
   * and fired on a session the server considered healthy. These pin the fix:
   * the local clock is a SUSPICION, and only the server can confirm it.
   */
  describe('the sliding server window, which the local clock cannot see', () => {
    it('does not interrupt an active user whose session the server has slid forward', async () => {
      // The login snapshot says 15 minutes. The user has been making requests
      // the whole time, so the server has quietly pushed the real deadline out
      // to an hour from now.
      const slidTo = NOW_S + 3600
      const fetchMock = stubValidate({ slidTo })
      render(<Probe session={fakeSession(NOW_S + 900)} isAuthenticated />)

      act(() => {
        vi.advanceTimersByTime(900_000)
      })
      await settle()

      // The watcher suspected a lapse and asked. Before this fix, it simply
      // prompted — this is the interruption the user complained about.
      expect(fetchMock).toHaveBeenCalled()
      expect(state()).toBe('quiet')
    })

    it('keeps counting from the server deadline, so it does not re-prompt every 15 minutes', async () => {
      const slidTo = NOW_S + 3600
      stubValidate({ slidTo })
      render(<Probe session={fakeSession(NOW_S + 900)} isAuthenticated />)

      // Four more stale-snapshot deadlines come and go. Under the old
      // behaviour this is four passphrase dialogs in an hour.
      for (let i = 0; i < 4; i += 1) {
        act(() => {
          vi.advanceTimersByTime(900_000)
        })
        await settle()
        expect(state()).toBe('quiet')
      }
    })

    it('still prompts once the server agrees the session is over', async () => {
      // Genuinely idle: the server never saw a request, so the window never
      // slid and the 401 is the truth. The timeout must still work.
      stubValidate({ expired: true })
      render(<Probe session={fakeSession(NOW_S + 900)} isAuthenticated />)

      act(() => {
        vi.advanceTimersByTime(900_000)
      })
      await settle()

      expect(state()).toBe('prompting')
    })

    it('does not prompt when the server is merely unreachable', async () => {
      // A lift, a tunnel, a dropped tunnel. This says nothing about the
      // session, and a passphrase typed here could not be verified anyway.
      stubValidate({ unreachable: true })
      render(<Probe session={fakeSession(NOW_S + 900)} isAuthenticated />)

      act(() => {
        vi.advanceTimersByTime(900_000)
      })
      await settle()

      expect(state()).toBe('quiet')
    })

    it('asks again after a backoff when the server was unreachable', async () => {
      const fetchMock = stubValidate({ unreachable: true })
      render(<Probe session={fakeSession(NOW_S + 900)} isAuthenticated />)

      act(() => {
        vi.advanceTimersByTime(900_000)
      })
      await settle()
      const afterFirst = fetchMock.mock.calls.length

      // Postponed, not abandoned: a session that really did end must still be
      // noticed once the network comes back.
      act(() => {
        vi.advanceTimersByTime(120_000)
      })
      await settle()

      expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst)
    })
  })
})
