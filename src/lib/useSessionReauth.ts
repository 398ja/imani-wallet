import { useEffect, useState } from 'react'
import type { NapSession } from '@imani/nap-client-web'

import { watchSessionExpiry } from './sessionExpiry'

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

  useEffect(() => {
    return watchSessionExpiry({
      getExpiresAt: () => session.getSession()?.expiresAt ?? null,
      // A fresh lapse always wins over an earlier dismissal.
      onExpired: () => setPrompt('lapsed'),
      // The watcher fires EARLY, while nap still considers the session live, so
      // a renewal in that window never flips `isAuthenticated`. Without this the
      // prompt would have nothing to close it.
      onRenewed: () => setPrompt('quiet'),
    })
  }, [session])

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

  // A session lost while the app was open needs the prompt whatever the timer
  // last thought — this is the half that catches a rejected or dropped cookie,
  // whose deadline has not arrived.
  const lost = !isAuthenticated && everAuthenticated

  return {
    // A live session cannot need a passphrase prompt, however it got that way,
    // and a dismissal silences the lapse it belongs to — including the moment
    // after a correct passphrase where the session is genuinely back but
    // `isAuthenticated` has not caught up yet. A later lapse re-opens it,
    // because the watcher sets `'lapsed'` over the dismissal.
    expired: prompt === 'dismissed' ? false : prompt === 'lapsed' || lost,
    // Dismissed by hand — the dialog's own submit path, the moment a correct
    // passphrase lands. NapProvider polls at 500ms and the watcher re-checks at
    // 1s, and either delay reads as the unlock not having worked.
    dismiss: () => setPrompt('dismissed'),
  }
}
