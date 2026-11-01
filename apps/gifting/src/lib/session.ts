/**
 * The buyer's session on the gifting site (#410): a NAP session cookie from payment-adapter, so it
 * survives leaving for Stripe and coming back (owner bug, 2026-10-29: the in-memory grant alone
 * died on the redirect, and the buyer came back signed out).
 *
 * Signing in is still the wallet's cross-origin grant (G10, `signer.ts`): the wallet window signs
 * ONE NAP login for this site, payment-adapter answers with an HttpOnly cookie (customers only:
 * a stall is refused at login, as at draft time), and the grant is handed back at once. From then
 * on nothing is signed: drafts ride the cookie. The key never comes here.
 */
import { AuthRequestError, createNapSession, CrossOriginSignerError } from '@imani/nap-client-web'

import { connect, type Connect } from './signer'

/** Where payment-adapter serves the gifting site's NAP login. Same origin (the edge routes it). */
export const AUTH_BASE = '/api/v1/gifting'

export interface Account {
  pubkey: string
}

export type SignInFailure = 'declined' | 'not-customer' | 'cancelled' | 'error'

export class SignInError extends Error {
  constructor(readonly reason: SignInFailure) {
    super(reason)
    this.name = 'SignInError'
  }
}

const base = () => `${window.location.origin}${AUTH_BASE}`

/** The session this browser already holds (the cookie), or null. Never throws for a 401. */
export async function currentAccount(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Account | null> {
  let r: Response
  try {
    r = await fetchImpl(`${base()}/auth/session`, { credentials: 'include' })
  } catch {
    return null
  }
  if (!r.ok) return null
  const body = (await r.json().catch(() => ({}))) as { principal?: { pubkey?: unknown }; pubkey?: unknown }
  const pubkey = typeof body.principal?.pubkey === 'string' ? body.principal.pubkey : body.pubkey
  return typeof pubkey === 'string' && /^[0-9a-f]{64}$/.test(pubkey) ? { pubkey } : null
}

/**
 * Sign in: the wallet window signs one NAP login, the cookie carries the session. MUST be called
 * from a click handler before any await (the popup opens inside `connect`).
 */
export function signIn(opts: { connectImpl?: Connect } = {}): Promise<Account> {
  const granted = connect(opts.connectImpl ? { connectImpl: opts.connectImpl } : {})
  return granted.then(
    async (session) => {
      try {
        const nap = createNapSession({ baseUrl: base(), signer: session.grant.signer, broadcast: { enabled: false } })
        const body = await nap.login()
        return { pubkey: body.principal.pubkey }
      } catch (error) {
        if (error instanceof AuthRequestError && error.status === 403) throw new SignInError('not-customer')
        throw new SignInError('error')
      } finally {
        // The cookie carries the session now: the wallet keeps nothing live for this site.
        session.grant.disconnect()
      }
    },
    (error: unknown) => {
      if (error instanceof CrossOriginSignerError && error.code === 'DECLINED') throw new SignInError('declined')
      if (error instanceof Error && /closed|denied|cancel/i.test(error.message)) throw new SignInError('cancelled')
      throw new SignInError('error')
    },
  )
}

/** End the session on payment-adapter. The wallet is not touched. */
export async function signOut(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<void> {
  await fetchImpl(`${base()}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined)
}
