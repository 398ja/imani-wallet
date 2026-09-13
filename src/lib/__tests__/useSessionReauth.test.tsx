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
import { act, cleanup, render, screen } from '@testing-library/react'

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
  const { expired } = useSessionReauth(session as never, isAuthenticated)
  return <span data-testid="state">{expired ? 'prompting' : 'quiet'}</span>
}

const state = () => screen.getByTestId('state').textContent

describe('useSessionReauth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('stays quiet while the session is live', () => {
    render(<Probe session={fakeSession(NOW_S + 3600)} isAuthenticated />)

    act(() => {
      vi.advanceTimersByTime(600_000)
    })

    expect(state()).toBe('quiet')
  })

  it('prompts when the session lapses under an open app', () => {
    render(<Probe session={fakeSession(NOW_S + 600)} isAuthenticated />)
    expect(state()).toBe('quiet')

    act(() => {
      vi.advanceTimersByTime(600_000)
    })

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

  it('re-arms for the NEXT lapse after a renewal', () => {
    const session = fakeSession(NOW_S + 600)
    const { rerender } = render(<Probe session={session} isAuthenticated />)

    act(() => {
      vi.advanceTimersByTime(600_000)
    })
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

    // A watcher that latched permanently would leave the second lapse silent —
    // the original bug, returning after one successful unlock.
    expect(state()).toBe('prompting')
  })
})
