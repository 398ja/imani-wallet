/**
 * Signing in on gifting.imani.casa with the wallet's key, without the key ever coming here
 * (#410 G5/G10, NAP extension 0002).
 *
 * `connectCrossOrigin` opens the wallet origin's `/nap/signer` popup, which asks the buyer to
 * unlock and consent once, then signs only kind 27235 (NIP-98) addressed to this origin. The
 * wallet's policy entry for us is:
 *
 *   'https://gifting.imani.casa': { kinds: [27235], audiences: ['https://gifting.imani.casa'] }
 *
 * Two browser rules the spec makes ours:
 * - call `connect` SYNCHRONOUSLY in the click handler (window.open after an await is blocked);
 * - this page must not send `Cross-Origin-Opener-Policy: same-origin` (we send
 *   `same-origin-allow-popups`), or the popup loses `window.opener` and can never answer.
 */
import { connectCrossOrigin, type CrossOriginGrant } from '@imani/nap-client-web'

import type { RemoteSigner } from './api'

/** The wallet's origin, `VITE_WALLET_ORIGIN`, else https://imani.casa. */
export const WALLET_ORIGIN: string =
  (import.meta.env?.VITE_WALLET_ORIGIN as string | undefined)?.replace(/\/+$/, '') || 'https://imani.casa'

export interface Session extends RemoteSigner {
  grant: CrossOriginGrant
  expiresAt: number
}

export type Connect = typeof connectCrossOrigin

/**
 * Start the handshake. MUST be called from a click handler before any await: the popup opens
 * inside this call. `expectedPubkey` re-checks "Myself" against the same wallet after a re-auth.
 */
export function connect(opts: { expectedPubkey?: string; connectImpl?: Connect } = {}): Promise<Session> {
  const run = opts.connectImpl ?? connectCrossOrigin
  const audience = window.location.origin
  return run({
    keyOrigin: WALLET_ORIGIN,
    kinds: [27235],
    audiences: [audience],
    expectedPubkey: opts.expectedPubkey,
  }).then((grant) => {
    const s: Session = {
      grant,
      pubkey: grant.info.pubkey,
      expiresAt: grant.info.expiresAt,
      signEvent: (t) => grant.signer.signEvent(t),
    }
    return s
  })
}

export function isLive(session: Session | null, now = Date.now() / 1000): session is Session {
  return !!session && session.grant.isActive() && session.expiresAt > now
}
