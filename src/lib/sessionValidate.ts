/**
 * Asking the server how long the session actually has left.
 *
 * The wallet used to decide this on its own, from the `expiresAt` that came
 * back with the login response, and that number is wrong almost immediately.
 *
 * The gateway runs a SLIDING idle window (`nap.session-idle-ttl-seconds`, 15
 * minutes by default, under an absolute 12-hour cap). Every authenticated
 * request goes through `/api/v1/auth/validate`, which advances
 * `last_activity_at` and pushes `expires_at` out to `now + idleTtl`. So a
 * session in active use never reaches the deadline it was issued with.
 *
 * Nothing told the client that. `createNapSession` records `expires_at` once,
 * at login, and `resume()` is the only thing that ever re-reads it — so the
 * local watcher counted down from a fifteen-minute-old snapshot and fired on
 * the dot, every fifteen minutes, regardless of what the user was doing. The
 * passphrase dialog landed mid-payment on a session the server considered
 * perfectly healthy, and dismissing it changed nothing because the next
 * snapshot was just as stale. That is the bug this fixes: not a timeout that
 * was too short, but a client clock that had stopped agreeing with the server's.
 *
 * `/auth/validate` is the authority, and it is also the same endpoint the edge
 * proxy calls for every request, so asking it here is neither a new mechanism
 * nor a new cost.
 */

/** What the server says about the session behind the current cookie. */
export interface SessionValidity {
  /** True when the session is still usable right now. */
  valid: boolean
  /**
   * The server's CURRENT deadline as a Unix timestamp in seconds — already slid
   * forward by this very call. Null when the server did not say, in which case
   * the caller keeps whatever it had rather than inventing one.
   */
  expiresAt: number | null
  /**
   * Distinguishes "the server says this session is over" from "we could not
   * reach the server". They must not be treated alike: a lapsed session has to
   * prompt, and a flaky network must NOT, or every tunnel and lift becomes a
   * passphrase dialog over whatever the user was doing.
   */
  reason: 'valid' | 'expired' | 'invalid' | 'unreachable'
}

/**
 * Ask the gateway whether the session is still live, and how long it now has.
 *
 * Note the side effect, which is the point rather than an accident: a
 * successful validate SLIDES the idle window. Calling it when the local clock
 * thinks time is nearly up is what keeps an active user signed in.
 *
 * Never throws. A caller deciding whether to interrupt someone mid-task cannot
 * be handed an exception for a dropped connection.
 */
export async function validateSession(
  fetchImpl: typeof fetch = fetch,
): Promise<SessionValidity> {
  let response: Response
  try {
    response = await fetchImpl('/api/v1/auth/validate', {
      method: 'GET',
      // The session cookie is the entire credential here.
      credentials: 'include',
    })
  } catch {
    // Offline, DNS, a dead tunnel. Says nothing about the session.
    return { valid: false, expiresAt: null, reason: 'unreachable' }
  }

  if (response.ok) {
    const expiresAt = await readExpiry(response)
    return { valid: true, expiresAt, reason: 'valid' }
  }

  if (response.status === 401) {
    // The one answer that genuinely means "ask for the passphrase". The body
    // carries `reason: expired | invalid`; both prompt, and the distinction is
    // kept for the copy the dialog shows.
    const reason = await readReason(response)
    return { valid: false, expiresAt: null, reason }
  }

  // 403 (a suspended pubkey), 5xx, a proxy error page. None of these is a
  // lapsed session, and none is recoverable by typing a passphrase, so none of
  // them should raise the dialog.
  return { valid: false, expiresAt: null, reason: 'unreachable' }
}

/**
 * Read the refreshed deadline out of a 200 body.
 *
 * Tolerant on purpose: a body that does not parse, or that omits the field,
 * yields null and the caller keeps its existing deadline. The session is known
 * good at this point — the server just said so with a 200 — and discarding that
 * answer over a shape surprise would prompt for a passphrase on a live session.
 */
async function readExpiry(response: Response): Promise<number | null> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return null
    const value = (body as { expires_at?: unknown }).expires_at
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

async function readReason(response: Response): Promise<'expired' | 'invalid'> {
  try {
    const body: unknown = await response.json()
    const value =
      typeof body === 'object' && body !== null
        ? (body as { reason?: unknown }).reason
        : null
    return value === 'expired' ? 'expired' : 'invalid'
  } catch {
    return 'invalid'
  }
}
