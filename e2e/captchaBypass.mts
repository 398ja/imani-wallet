/**
 * The e2e suites' way past the edge bot check on the cashback code lookup.
 *
 * imani-deploy's edge runs FCaptcha (nginx/conf.d/lua/captcha_gate.lua) on
 * `GET /api/v1/portal/cashback/by-code/{code}`. Playwright's Chromium is, correctly, scored as a
 * bot, so once the gate is in `enforce` mode every suite that looks a code up would be refused.
 * The edge accepts `X-Imani-Captcha-Bypass` equal to a secret it holds (compared in constant time,
 * never logged, stripped before the portal).
 *
 * Set E2E_CAPTCHA_BYPASS to that secret. Unset (local stacks, observe mode), nothing is sent and
 * nothing changes. The header goes ONLY on by-code requests: it is a secret, and every other
 * route is none of its business.
 */
import type { BrowserContext } from 'playwright'

export const CAPTCHA_BYPASS_HEADER = 'X-Imani-Captcha-Bypass'
const BY_CODE = '/api/v1/portal/cashback/by-code/'

export function captchaBypassHeaders(): Record<string, string> {
  const secret = process.env.E2E_CAPTCHA_BYPASS ?? ''
  return secret ? { [CAPTCHA_BYPASS_HEADER]: secret } : {}
}

/** Add the bypass to every by-code request this context makes. A no-op without the secret. */
export async function bypassCaptcha(ctx: BrowserContext): Promise<void> {
  const headers = captchaBypassHeaders()
  if (!Object.keys(headers).length) return
  await ctx.route((url) => url.pathname.startsWith(BY_CODE), (route) =>
    route.fallback({ headers: { ...route.request().headers(), ...headers } }),
  )
}
