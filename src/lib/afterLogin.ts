/**
 * Where to go once a visitor has logged in (#280).
 *
 * `PublicRoutes` sends every authed deep link to `Entry` and does not keep it,
 * so a visitor who tapped Buy on a stall would unlock into a home screen. This
 * holds ONE in-app path across the login, in sessionStorage because the
 * detour is a same-tab errand and nothing here is secret.
 *
 * Only `/buy/<hex pubkey>` is accepted, on write and on read: a stored path is
 * a redirect, and an open redirect is not something to keep in storage.
 */

const KEY = 'imani:afterLogin'
const ALLOWED = /^\/buy\/[0-9a-f]{64}$/

export function rememberAfterLogin(path: string): void {
  if (!ALLOWED.test(path)) return
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    // Private mode or storage full: they land on home, as before.
  }
}

/** The remembered path, removed as it is read so it is followed once. */
export function takeAfterLogin(): string | undefined {
  try {
    const path = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return path !== null && ALLOWED.test(path) ? path : undefined
  } catch {
    return undefined
  }
}
