// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

import { currentAccount, signIn, signOut, SignInError } from '../session'

/**
 * The gifting site's session (#410, owner bug 2026-10-29: signed out after Stripe). The wallet's
 * window signs ONE NAP login; the cookie carries the session from then on, so it survives leaving
 * for Stripe and coming back.
 */

const PUB = 'ab'.repeat(32)

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('currentAccount: the cookie survives the trip to Stripe', () => {
  it('reads the session the cookie carries, with credentials', async () => {
    const f = vi.fn(async () => json(200, { principal: { pubkey: PUB } }))
    expect(await currentAccount(f as unknown as typeof fetch)).toEqual({ pubkey: PUB })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${window.location.origin}/api/v1/gifting/auth/session`)
    expect(init.credentials).toBe('include')
  })
  it('no session, an odd answer, or no network is simply signed out', async () => {
    expect(await currentAccount((async () => json(401, {})) as unknown as typeof fetch)).toBeNull()
    expect(await currentAccount((async () => json(200, { principal: { pubkey: 'not-a-key' } })) as unknown as typeof fetch)).toBeNull()
    expect(await currentAccount((async () => { throw new TypeError('net') }) as unknown as typeof fetch)).toBeNull()
  })
})

describe('signIn', () => {
  it('a declined wallet window is "declined", and nothing is logged in', async () => {
    const { CrossOriginSignerError } = await import('@imani/nap-client-web')
    const connectImpl = vi.fn(async () => {
      throw new CrossOriginSignerError('DECLINED')
    })
    await expect(signIn({ connectImpl: connectImpl as never })).rejects.toEqual(new SignInError('declined'))
  })
})

describe('signOut', () => {
  it('ends the session on the service, never touching the wallet', async () => {
    const f = vi.fn(async () => json(200, {}))
    await signOut(f as unknown as typeof fetch)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${window.location.origin}/api/v1/gifting/auth/logout`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
  })
})
