/**
 * @vitest-environment jsdom
 *
 * What the wallet does with each answer from `/api/v1/auth/validate`.
 *
 * The distinctions here are the whole value of the module. The endpoint has
 * three meaningfully different outcomes and the wallet must react differently
 * to each: a 200 carries a deadline the server has just slid forward, a 401
 * means the session is genuinely over, and anything else — a dropped
 * connection, a 502 from a proxy — means nothing at all about the session and
 * must NOT be allowed to interrupt the user.
 *
 * Collapsing the third case into the second is how a tunnel or a lift turns
 * into a passphrase dialog over someone's payment, so it is tested explicitly.
 */
import { describe, expect, it, vi } from 'vitest'

import { validateSession } from '../sessionValidate'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status })

describe('validateSession', () => {
  it('reports the refreshed deadline from a 200', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { status: 'ok', expires_at: 1_800_000_900, absolute_expiry_at: 1_800_043_200 }),
    )

    const verdict = await validateSession(fetchImpl as unknown as typeof fetch)

    // This number is the point of the call: it is later than whatever the
    // client had, because asking slid the window.
    expect(verdict).toEqual({ valid: true, expiresAt: 1_800_000_900, reason: 'valid' })
  })

  it('sends the session cookie, which is the entire credential', async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: 'ok', expires_at: 1 }))

    await validateSession(fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/v1/auth/validate',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('reports an expired session from a 401, with the server reason', async () => {
    const fetchImpl = vi.fn(async () =>
      json(401, { error: 'session_ended', reason: 'expired', message: 'Session expired' }),
    )

    const verdict = await validateSession(fetchImpl as unknown as typeof fetch)

    expect(verdict).toEqual({ valid: false, expiresAt: null, reason: 'expired' })
  })

  it('distinguishes an invalid session from an expired one', async () => {
    const fetchImpl = vi.fn(async () =>
      json(401, { error: 'session_ended', reason: 'invalid', message: 'Session not found' }),
    )

    const verdict = await validateSession(fetchImpl as unknown as typeof fetch)

    expect(verdict.reason).toBe('invalid')
  })

  it('does not call a dropped connection an expired session', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    const verdict = await validateSession(fetchImpl as unknown as typeof fetch)

    // `unreachable`, never `expired`: the caller uses exactly this distinction
    // to decide whether interrupting the user is justified.
    expect(verdict).toEqual({ valid: false, expiresAt: null, reason: 'unreachable' })
  })

  it('does not treat a server error as an expired session', async () => {
    const fetchImpl = vi.fn(async () => json(502, { error: 'bad gateway' }))

    const verdict = await validateSession(fetchImpl as unknown as typeof fetch)

    // A passphrase cannot fix a 502, so it must not be asked for.
    expect(verdict.reason).toBe('unreachable')
  })

  it('does not treat a denied principal as an expired session', async () => {
    // 403 is a suspended pubkey. Re-authenticating would succeed and change
    // nothing, so the dialog would be a loop.
    const fetchImpl = vi.fn(async () => json(403, { status: 'error', reason: 'denied' }))

    const verdict = await validateSession(fetchImpl as unknown as typeof fetch)

    expect(verdict.reason).toBe('unreachable')
  })

  it('keeps a known-good session when the 200 body is not what was expected', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>proxy</html>', { status: 200 }))

    const verdict = await validateSession(fetchImpl as unknown as typeof fetch)

    // The server said 200: the session is live. A null deadline tells the
    // caller to keep the one it already had rather than invent one.
    expect(verdict).toEqual({ valid: true, expiresAt: null, reason: 'valid' })
  })

  it('ignores a non-numeric expires_at rather than trusting it', async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: 'ok', expires_at: 'soon' }))

    const verdict = await validateSession(fetchImpl as unknown as typeof fetch)

    expect(verdict.valid).toBe(true)
    expect(verdict.expiresAt).toBeNull()
  })
})
