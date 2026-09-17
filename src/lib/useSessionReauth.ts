import { useEffect, useState } from 'react'
import type { NapSession } from '@imani/nap-client-web'

import { watchSessionExpiry } from './sessionExpiry'
import { validateSession } from './sessionValidate'

/**
 * How long to wait before asking again when the server could not be reached.
 *
 * Short, because the session really may have lapsed and this is a deliberate
 * postponement of finding out. Not so short that a phone with no signal spends
 * its battery re-asking: one minute is roughly the interval at which someone
 * walking out of a dead spot would want the wallet to notice.
 */
const RETRY_AFTER_UNREACHABLE_S = 60

/**
 * Deciding when to ask for the passphrase again.
 *
 * This is a hook rather than a few lines inside `Gate` because the decision has
 * three cases that are easy to get subtly wrong and impossible to see in a
 * screenshot, and each one has a failure mode worse than the bug being fixed:
 *
 *   - **The clock ran out.** The server told us the deadline at login, so this
 *     is known in advance rather than discovered when a request fails. This is
 *     the external signal, and it arrives through `watchSessionExpiry`.
 *   - **The session was lost some other way.** A rejected or dropped cookie
 *     shows up as `isAuthenticated` going false. Reacting to that ALONE would
 *     be wrong, because it is also false for the moment between mounting and
 *     the first login resolving — a passphrase box over a sign-in that is
 *     already succeeding.
 *   - **It came back.** Re-authentication can land from this tab's own dialog or
 *     from another tab, over nap's BroadcastChannel. Either way the prompt has
 *     stopped being true and must close itself, or the user is asked to unlock a
 *     session that is already open.
 *
 * The second and third are DERIVED DURING RENDER rather than pushed into state
 * from an effect. `isAuthenticated` is already React state — the provider polls
 * the session and sets it — so an effect that watched it only to call another
 * setState would be a second render pass carrying information the first one
 * already had, which is what `react-hooks/set-state-in-effect` is pointing at.
 * Only the timer, a genuinely external system, is allowed to push.
 *
 * @param isAuthenticated from `useNapSession()` — the provider polls the session
 *   for it, so it is the reactive view of state the session holds imperatively.
 */
export function useSessionReauth(
  session: Pick<NapSession, 'getSession'>,
  isAuthenticated: boolean,
): { expired: boolean; dismiss: () => void } {
  /**
   * What the app has decided to show, as one value rather than two booleans.
   *
   * `dismissed` has to be paired with the lapse it belongs to, not held on its
   * own. A standalone "the user dismissed it" flag is never cleared by anything,
   * so the FIRST successful unlock would suppress the dialog for the rest of the
   * tab's life and the second lapse would be silent — the original bug, returned
   * by a shorter route. Keeping them together means a new lapse necessarily
   * replaces the dismissal that preceded it.
   */
  const [prompt, setPrompt] = useState<'quiet' | 'lapsed' | 'dismissed'>('quiet')

  /**
   * The server's answer, which overrides the local deadline.
   *
   * The local `expiresAt` is a snapshot taken at login, and the gateway slides
   * its idle window forward on every authenticated request — so for anyone
   * actually using the wallet the snapshot is stale within seconds and the
   * watcher fires against a session that is nowhere near expiry. Holding the
   * confirmed deadline here lets `watchSessionExpiry` count down from what the
   * server currently believes rather than from what it said a quarter of an
   * hour ago.
   *
   * A ref-like piece of state rather than a `useRef` because the watcher reads
   * it through a closure that is created once per session; a plain mutable box
   * is exactly what is wanted and re-rendering on every slide would be noise.
   */
  const [confirmedExpiry] = useState<{ current: number | null }>(() => ({ current: null }))

  useEffect(() => {
    let cancelled = false

    const stop = watchSessionExpiry({
      getExpiresAt: () => {
        const local = session.getSession()?.expiresAt ?? null
        const confirmed = confirmedExpiry.current
        if (local === null) return confirmed
        if (confirmed === null) return local
        // Whichever deadline is LATER is the truthful one. `confirmed` comes
        // from a validate that slid the window, and `local` moves forward on a
        // fresh login; taking the max means neither a re-login nor a slide can
        // be masked by the other's older number.
        return Math.max(local, confirmed)
      },
      /**
       * The local clock says time is up. Before interrupting anyone, ask the
       * server — which is the only thing that knows about the sliding window,
       * and which slides it once more by being asked.
       *
       * This is the fix for the every-15-minutes popup: an active user's
       * session has already been extended by their own traffic, so this call
       * returns a fresh deadline, the watcher re-arms against it, and no dialog
       * is ever shown. Only a session the server AGREES is over prompts.
       */
      onExpired: () => {
        void validateSession().then((verdict) => {
          if (cancelled) return

          if (verdict.valid) {
            // Still alive, and now slid further forward. Record the server's
            // deadline so the watcher stops counting from the stale one, and
            // stay quiet: the user never learns this happened, which is the
            // entire point.
            confirmedExpiry.current = verdict.expiresAt
            setPrompt('quiet')
            return
          }

          if (verdict.reason === 'unreachable') {
            // A network failure is not an expired session. Prompting here would
            // put a passphrase box in front of every user who walked into a
            // lift, and typing it could not succeed anyway — re-authentication
            // needs the same network that just failed. Push the local deadline
            // out a little and let the watcher ask again.
            confirmedExpiry.current = Math.floor(Date.now() / 1000) + RETRY_AFTER_UNREACHABLE_S
            setPrompt('quiet')
            return
          }

          // The server says the session is over. Now the dialog is the truth.
          confirmedExpiry.current = null
          setPrompt('lapsed')
        })
      },
      // The watcher fires EARLY, while nap still considers the session live, so
      // a renewal in that window never flips `isAuthenticated`. Without this the
      // prompt would have nothing to close it.
      onRenewed: () => setPrompt('quiet'),
    })

    return () => {
      // An in-flight validate outlives the unmount, and resolving it into a
      // dead component would both warn and, worse, decide the prompt state of a
      // session this hook no longer speaks for.
      cancelled = true
      stop()
    }
  }, [session, confirmedExpiry])

  /**
   * Has this session ever been established?
   *
   * It distinguishes a session that LAPSED from one that has not started yet.
   * In this app `Gate` only mounts after a login has resolved, so the second
   * case does not arise there — but a hook that prompts for a passphrase must
   * not depend on its one caller's mounting order to avoid flashing a dialog
   * over a sign-in in progress, so it is handled here rather than assumed away.
   *
   * Seeded from the current value and advanced with a render-phase update, which
   * is React's own sanctioned pattern for deriving state from changing input: it
   * re-runs this component before anything is committed, so nothing downstream
   * ever renders against the stale value and there is no second pass. An effect
   * here would be exactly the cascading render `react-hooks/set-state-in-effect`
   * exists to stop, and a ref read during render is no better.
   */
  const [everAuthenticated, setEverAuthenticated] = useState(isAuthenticated)
  if (isAuthenticated && !everAuthenticated) setEverAuthenticated(true)

  /**
   * A dismissal only silences the state of the world it was made in.
   *
   * `dismiss()` is called the instant a correct passphrase lands, to close the
   * dialog without waiting for NapProvider's 500ms poll. In that window
   * `isAuthenticated` is briefly still false while being about to become true,
   * which is the ONLY thing the dismissal is meant to cover.
   *
   * So it is recorded against the authentication state at the time. Once
   * `isAuthenticated` has gone true and come back down, this is a NEW loss —
   * a second expiry, a revoked cookie — and the old dismissal must not silence
   * it. Without this pairing the second failure renders the dead screen the
   * whole change exists to remove, and only a timer-driven lapse could ever
   * recover it.
   */
  const [dismissedWhileAuthed, setDismissedWhileAuthed] = useState(false)
  if (isAuthenticated && prompt === 'dismissed' && !dismissedWhileAuthed) {
    setDismissedWhileAuthed(true)
  }

  // A session lost while the app was open needs the prompt whatever the timer
  // last thought — this is the half that catches a rejected or dropped cookie,
  // whose deadline has not arrived.
  const lost = !isAuthenticated && everAuthenticated

  // Live and never lapsed: nothing to ask about.
  const stale = prompt === 'lapsed' || lost

  return {
    // A dismissal silences only the lapse it was made in. Once the session has
    // come back (`dismissedWhileAuthed`), a later loss is a fresh one and
    // reopens the dialog.
    expired: prompt === 'dismissed' && !dismissedWhileAuthed ? false : stale,
    dismiss: () => {
      setPrompt('dismissed')
      // Reset the pairing: this dismissal belongs to the CURRENT state, not to
      // whatever an earlier one was recorded against.
      setDismissedWhileAuthed(false)
    },
  }
}
