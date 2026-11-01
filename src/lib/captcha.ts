/**
 * The bot check in front of the public cashback code lookup.
 *
 * `GET /api/v1/portal/cashback/by-code/{code}` is the one call this app makes with no
 * credential at all: the code is the credential. The edge can run a self-hosted FCaptcha
 * gate on it (imani-deploy, `nginx/conf.d/lua/captcha_gate.lua`), which wants a single-use
 * token for the action `cashback_lookup` in the `X-Imani-Captcha` header.
 *
 * FAIL-OPEN, ON PURPOSE. Every path here ends in "send the lookup", with or without a token:
 *
 *   - a deployment with no gate has no `/fcaptcha/fcaptcha.js` (the SPA answers that path, the
 *     script never defines `FCaptcha`), so the check switches itself off for the session;
 *   - a script that fails to load, a solver that throws, or a token slower than
 *     `TOKEN_BUDGET_MS` all mean "no header";
 *   - whether a missing token is refused is the EDGE's decision (observe mode logs it, enforce
 *     mode answers 403), never this file's. The app cannot tell a bot from a slow phone, and
 *     must not strand a customer's cashback by guessing.
 *
 * Same origin: the widget, its proof-of-work workers (blob:) and its three API paths are all
 * served under `/fcaptcha/` by the edge, which the wallet's CSP already allows. Nothing is sent
 * to a third party, and the widget sets no cookies.
 *
 * The session is started early (`prewarmCaptcha`, on the screens that look a code up) so the
 * proof of work and the signals it scores are collected while the customer is still typing,
 * and the lookup itself waits as little as possible.
 */

const SCRIPT_URL = '/fcaptcha/fcaptcha.js'
const SERVER_URL = '/fcaptcha'
export const CAPTCHA_SITE_KEY = 'imani-wallet'
export const CAPTCHA_HEADER = 'X-Imani-Captcha'
/** The action the edge gate accepts, bound into the token by the server. */
export const CASHBACK_LOOKUP_ACTION = 'cashback_lookup'
/** Longest a lookup waits for a token before going without one. */
export const TOKEN_BUDGET_MS = 6_000
const SCRIPT_BUDGET_MS = 5_000

interface FCaptchaResult {
  success?: boolean
  token?: string | null
}
interface FCaptchaSession {
  execute(action?: string, cdata?: string): Promise<FCaptchaResult>
  destroy(): void
}
interface FCaptchaGlobal {
  configure(options: { serverUrl: string }): void
  invisible(options: { siteKey: string; serverUrl: string; autoScore: boolean }): FCaptchaSession
}

let loading: Promise<FCaptchaGlobal | null> | null = null
let session: FCaptchaSession | null = null

function globalFCaptcha(): FCaptchaGlobal | null {
  const g = (globalThis as { FCaptcha?: unknown }).FCaptcha as FCaptchaGlobal | undefined
  return g && typeof g.invisible === 'function' ? g : null
}

/** Load the widget once. Resolves null, for the rest of the session, when there is none. */
function load(): Promise<FCaptchaGlobal | null> {
  if (loading) return loading
  loading = new Promise<FCaptchaGlobal | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null)
    const existing = globalFCaptcha()
    if (existing) return resolve(existing)

    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    const timer = setTimeout(() => resolve(null), SCRIPT_BUDGET_MS)
    script.onload = () => {
      clearTimeout(timer)
      const g = globalFCaptcha()
      try {
        g?.configure({ serverUrl: SERVER_URL })
      } catch {
        return resolve(null)
      }
      resolve(g)
    }
    script.onerror = () => {
      clearTimeout(timer)
      resolve(null)
    }
    document.head.appendChild(script)
  })
  return loading
}

async function ensureSession(): Promise<FCaptchaSession | null> {
  if (session) return session
  const g = await load()
  if (!g) return null
  try {
    session = g.invisible({ siteKey: CAPTCHA_SITE_KEY, serverUrl: SERVER_URL, autoScore: false })
  } catch {
    session = null
  }
  return session
}

/**
 * Start collecting early, on a screen that is about to look a code up. Never throws, never
 * blocks the screen.
 */
export function prewarmCaptcha(): void {
  void ensureSession().catch(() => null)
}

/**
 * A fresh single-use token for `action`, or null. Never throws, never waits longer than
 * `budgetMs`. Each lookup needs its own: the edge refuses a token it has already seen.
 */
export async function captchaToken(
  action: string = CASHBACK_LOOKUP_ACTION,
  budgetMs: number = TOKEN_BUDGET_MS,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs)
  })
  const attempt = (async () => {
    const s = await ensureSession()
    if (!s) return null
    const result = await s.execute(action)
    return typeof result?.token === 'string' && result.token !== '' ? result.token : null
  })().catch(() => null)
  try {
    return await Promise.race([attempt, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The header to add to a by-code lookup: the token if one came in time, else nothing. */
export async function captchaHeaders(action: string = CASHBACK_LOOKUP_ACTION): Promise<Record<string, string>> {
  const token = await captchaToken(action)
  return token ? { [CAPTCHA_HEADER]: token } : {}
}

/** Tests only: forget the loaded widget and session. */
export function resetCaptchaForTests(): void {
  try {
    session?.destroy()
  } catch {
    // a broken stub must not fail the next test
  }
  session = null
  loading = null
}
