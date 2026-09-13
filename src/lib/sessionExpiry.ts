/**
 * Noticing that the NAP session has lapsed, without waiting for a request to fail.
 *
 * nap's client does not expire a session locally. `createNapSession` records
 * `expiresAt` from the auth response and then leaves it alone: `isAuthenticated()`
 * keeps answering true until something makes a request and gets a 401, at which
 * point `resume()` clears the state and fires `onSessionExpired`. That is fine
 * for an app that is constantly talking to the server, and wrong for this one —
 * a wallet left open on the coupons screen makes no requests at all, so the
 * session could be an hour dead before anything noticed, and the user's next tap
 * failed for a reason the screen had never mentioned.
 *
 * This is the missing local clock. It fires at the deadline the server already
 * told us about, so the passphrase dialog opens the moment the session lapses
 * rather than after the user has hit a wall.
 *
 * Two things make it more than a `setTimeout`:
 *
 *   - **Background tabs throttle timers.** A phone with the wallet in the
 *     background may not run the callback anywhere near the deadline, so the
 *     deadline is re-checked on `visibilitychange` and a session that lapsed
 *     while the tab slept locks immediately on return rather than whenever the
 *     throttled timer eventually fires.
 *   - **The deadline moves.** A fresh login pushes it forward, so the deadline
 *     is READ at each tick from the live session rather than captured once. A
 *     scheduler holding a stale copy would fire against a session that had
 *     already been renewed underneath it.
 */

/** Just under the 32-bit `setTimeout` ceiling, past which it fires immediately. */
const MAX_DELAY_MS = 2_147_000_000

export interface ExpiryWatchOptions {
  /**
   * The session's expiry as a Unix timestamp in SECONDS — the unit
   * `SessionState.expiresAt` carries, straight off the server's `expires_at`.
   * Return null when there is no session to watch; the watcher then idles
   * rather than treating "no deadline" as "expired".
   */
  getExpiresAt: () => number | null
  /**
   * Called once per lapse, on the transition only. A watcher that re-fired on
   * every tick past the deadline would reopen a dialog the user is typing into.
   */
  onExpired: () => void
  /**
   * Called when the deadline moves back into the future after a lapse — a
   * re-authentication landed, here or in another tab over nap's
   * BroadcastChannel.
   *
   * This exists because `isAuthenticated` is not a reliable signal for it. The
   * watcher deliberately fires EARLY, while nap still considers the session
   * live, so a renewal that happens in that window never flips the flag and
   * nothing else would ever close the dialog. Without this a user whose other
   * tab renewed the session sits in front of a passphrase prompt for a session
   * that is already open — the original dead-end bug, one layer up.
   */
  onRenewed?: () => void
  /** Injected for tests. Milliseconds, like `Date.now`. */
  now?: () => number
  /**
   * How early to fire, in ms. The dialog is worth opening a moment BEFORE the
   * server stops accepting the cookie: re-authenticating at the deadline races
   * a request already in flight, and losing that race is the failed tap this
   * exists to prevent.
   */
  graceMs?: number
}

/**
 * Watch a session's deadline. Returns a stop function; calling it twice is safe.
 */
export function watchSessionExpiry({
  getExpiresAt,
  onExpired,
  onRenewed,
  now = Date.now,
  graceMs = 5_000,
}: ExpiryWatchOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let fired = false
  let stopped = false

  const deadlineMs = (): number | null => {
    const seconds = getExpiresAt()
    if (seconds === null || !Number.isFinite(seconds)) return null
    return seconds * 1000 - graceMs
  }

  const check = () => {
    if (stopped) return
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }

    const deadline = deadlineMs()
    if (deadline === null) {
      // No session, or one whose expiry we cannot read. Keep polling slowly so a
      // session established AFTER the watcher started is still picked up — this
      // is what makes the watcher safe to mount before the login completes.
      timer = setTimeout(check, 1_000)
      return
    }

    const remaining = deadline - now()
    if (remaining <= 0) {
      // Latch. The deadline stays in the past until a fresh login moves it, and
      // firing on every subsequent tick would reopen the dialog under the user's
      // cursor. Cleared below, when a renewed session pushes the deadline out.
      if (!fired) {
        fired = true
        onExpired()
      }
      // Keep watching: a successful re-authentication moves the deadline
      // forward, and this is what re-arms the watcher for the next lapse.
      timer = setTimeout(check, 1_000)
      return
    }

    // The deadline moved past `now` again — a re-authentication landed — so the
    // latch is released and the next lapse will fire.
    if (fired) {
      fired = false
      onRenewed?.()
    }
    timer = setTimeout(check, Math.min(remaining, MAX_DELAY_MS))
  }

  // Timers are throttled while the tab is hidden, so a lapse that happens in the
  // background may not be noticed until long after the fact. Re-check on return.
  const onVisibility = () => {
    if (document.visibilityState === 'visible') check()
  }
  document.addEventListener('visibilitychange', onVisibility)

  check()

  return () => {
    if (stopped) return
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
