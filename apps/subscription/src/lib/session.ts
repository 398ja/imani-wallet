/**
 * The stall's session on the subscription site (#411).
 *
 * There is no login page. The stall arrives from its WALLET (Settings › Subscription › Upgrade),
 * which opened this tab and holds the unlocked key. This module asks that wallet tab, over
 * `postMessage` (NAP extension 0002, `connectCrossOrigin` attached to `window.opener`), to sign
 * one NAP login for this site. The service answers with an HttpOnly session cookie, merchants only,
 * and from then on nothing is signed: every API call rides the cookie.
 *
 * The key never reaches this origin. The wallet signs only proofs addressed to THIS site.
 */
import {
  AuthRequestError,
  connectCrossOrigin,
  createNapSession,
  CrossOriginSignerError,
  type CrossOriginErrorCode,
} from '@imani/nap-client-web'

import { BASE } from './api'

/**
 * Where the wallet lives: the ONE origin this site accepts a signer from. Per-environment
 * configuration (`VITE_WALLET_ORIGIN`, a build arg, required by the Dockerfile), never code. Unset,
 * the site accepts no signer at all and every visit ends on "Open this from your wallet".
 */
export const WALLET_ORIGIN: string | null = (() => {
  const configured = ((import.meta.env.VITE_WALLET_ORIGIN as string | undefined) ?? '').trim()
  if (!configured) return null
  try {
    const url = new URL(configured)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
})()

export interface Account {
  pubkey: string
  roles: string[]
}

export type SignInFailure =
  /** Not opened from the wallet (no opener), or the wallet tab is gone: open it from the wallet. */
  | 'from-wallet'
  /** The wallet is locked: unlock it, then try again here. */
  | 'locked'
  /** Signed in, but this account has no stall. */
  | 'not-merchant'
  /** The wallet is signed in as a different stall than the one this tab was opened for. */
  | 'wrong-account'
  /** Anything else: the service or the network. */
  | 'error'

export class SignInError extends Error {
  readonly reason: SignInFailure
  constructor(reason: SignInFailure, message?: string) {
    super(message ?? reason)
    this.reason = reason
  }
}

const apiBase = () => `${window.location.origin}${BASE}/v1`

/** The session the browser already holds, or null. Never throws for a plain 401. */
export async function currentAccount(fetchImpl: typeof fetch = fetch): Promise<Account | null> {
  const r = await fetchImpl(`${apiBase()}/auth/session`, { credentials: 'include' })
  if (r.status === 401) return null
  if (!r.ok) throw new SignInError('error', `The plans service answered ${r.status}.`)
  const body = (await r.json()) as { principal?: { pubkey?: string }; roles?: string[] }
  const pubkey = body.principal?.pubkey
  if (!pubkey) return null
  return { pubkey, roles: body.roles ?? [] }
}

/** Which stall the wallet opened this tab for (`?as=<hex>`), if it said. */
export function expectedStall(search = window.location.search): string | undefined {
  const as = new URLSearchParams(search).get('as')?.toLowerCase()
  return as && /^[0-9a-f]{64}$/.test(as) ? as : undefined
}

function failureFor(code: CrossOriginErrorCode): SignInFailure {
  switch (code) {
    case 'DECLINED':
      return 'locked'
    case 'REFUSED':
      return 'wrong-account'
    default:
      return 'from-wallet'
  }
}

/**
 * Sign in through the wallet tab that opened this one. Resolves with the merchant account, or
 * rejects with a `SignInError` saying what the stall can do about it.
 */
export async function signInThroughWallet(opts: { expectedPubkey?: string; readyTimeoutMs?: number } = {}): Promise<Account> {
  const opener = window.opener as Window | null
  if (!opener || !WALLET_ORIGIN) throw new SignInError('from-wallet')
  const keyOrigin = WALLET_ORIGIN

  let grant
  try {
    grant = await connectCrossOrigin({
      keyOrigin,
      kinds: [27235],
      audiences: [window.location.origin],
      expectedPubkey: opts.expectedPubkey,
      // Not a popup: the wallet IS the window that opened us. It says "ready" to us; we answer it.
      // nap matches every reply against this exact window (`event.source`). Its clean-up calls
      // `close()` on it, which a cross-origin page cannot do to a window it did not open: the browser
      // ignores it (checked in Chromium), so the stall's wallet tab stays open.
      open: () => opener,
      readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
      connectTimeoutMs: 20_000,
    })
  } catch (error) {
    throw new SignInError(error instanceof CrossOriginSignerError ? failureFor(error.code) : 'error')
  }

  try {
    const session = createNapSession({ baseUrl: apiBase(), signer: grant.signer, broadcast: { enabled: false } })
    try {
      const body = await session.login()
      return { pubkey: body.principal.pubkey, roles: body.roles ?? [] }
    } catch (error) {
      if (error instanceof AuthRequestError && error.status === 403) throw new SignInError('not-merchant')
      throw new SignInError('error')
    }
  } finally {
    // The cookie carries the session now. Hand the grant back so the wallet holds nothing live.
    grant.disconnect()
  }
}

/** End the session on the service. The wallet is not touched. */
export async function signOut(fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(`${apiBase()}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined)
}
