/**
 * Test seams, and why they must be switched off in production.
 *
 * IW-05: `redeem.ts` and `licence.ts` both read `now` from the REQUEST BODY and fall back to the
 * server clock only when it is absent. Their docstrings explain the field exists "so expiry is
 * testable to the second" — a test seam wired straight into the production request parser.
 *
 * That value drives every time-based refusal:
 *   - the expired-coupon branch in redeem (`voucher.expiresAt <= input.now`)
 *   - `verifyLicence`, whose whole rule is `expires_at > now`
 *   - `decideWithGrace`, which compares `lastVerification.at + windowSeconds` against it
 *
 * So any caller could redeem a coupon that expired last year by sending
 * `{"now": 1600000000}`, and `/v1/redeem/prepare` gates on exactly that verdict before handing a
 * till the receive URL and body — the till is told an expired coupon is good and signs for it.
 *
 * The licence path is worse: `checkLicence` is deliberately offline and local, with no licence
 * server behind it (ADR 0007), so there is no downstream authority to catch the lie. An expired
 * licence plus any past timestamp returns `granted: true` with the full feature list,
 * permanently. And because `lastVerification` is caller-supplied too, an attacker can invent the
 * history that the grace window is computed from — "no history, no window" is unenforceable when
 * the caller supplies the history.
 *
 * The seam is genuinely useful in tests, so it is kept and gated rather than deleted. It is off
 * unless explicitly enabled, and enabling it in a deployed environment is a decision somebody has
 * to write down.
 */

/** Whether caller-supplied clock and history overrides are honoured. */
export function testSeamsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WALLET_API_ALLOW_TEST_SEAMS === 'true'
}

/**
 * The effective "now", in epoch seconds.
 *
 * Returns the server clock unless test seams are explicitly enabled. A caller-supplied clock is
 * not an input to a security decision; it is the security decision, made by the attacker.
 *
 * @param supplied the `now` from the request body, if any
 * @param serverNow the server's own clock reading
 */
export function effectiveNow(
  supplied: unknown,
  serverNow: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!testSeamsEnabled(env)) return serverNow
  const n = Number(supplied ?? serverNow)
  return Number.isFinite(n) ? n : serverNow
}

/**
 * Whether caller-supplied verification history may be trusted.
 *
 * The grace window is computed from `lastVerification`, so accepting one from the request lets
 * the caller manufacture the evidence that grants them grace.
 */
export function acceptsCallerHistory(env: NodeJS.ProcessEnv = process.env): boolean {
  return testSeamsEnabled(env)
}
