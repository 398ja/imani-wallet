import { useEffect, useRef, useState } from 'react'

import { storedTerminal } from './terminalEnrol'
import { loginTerminal, type LoginOutcome } from './terminalLogin'
import { credentialState, unspentForLogin } from './credentialRevocation'
import type { TerminalActor } from './actor'
import type { TerminalSession } from './terminalSession'

/**
 * Is this device a terminal, and what may it do right now?
 *
 * Terminals ticket 10, and what finally makes ticket 07's role gating
 * reachable: until this existed, `App` rendered the till with no actor and no
 * session, so the gating was correct code nobody could reach.
 *
 * ## It resolves to "owner" quickly, and to "terminal" carefully
 *
 * The overwhelming majority of devices are the stall's own, and they must not
 * pay for the terminal path: with no stored credential this settles
 * immediately with `actor: null`, which is the shape `MerchantHomePage` already
 * treats as "behave exactly as before".
 *
 * ## The mint is asked, but never waited on for permission to trade
 *
 * A terminal opens on what it holds, then confirms with the mint. If the mint
 * says the credential is spent the device is refused; if it cannot be reached
 * the session is REDUCED — redemption yes, issuance no. A queue at a stall
 * cannot wait for the network to agree, and issuance is value-bearing.
 */

export interface TerminalIdentity {
  /** Null on the stall's own device, which is the common case. */
  actor: TerminalActor | null
  session: TerminalSession | null
  /** Set when this device HAS a credential but was refused. */
  refusal: string | null
  /** False until the first answer, so screens do not flash the wrong state. */
  ready: boolean
}

const OWNER: TerminalIdentity = { actor: null, session: null, refusal: null, ready: true }

/** What the hook needs of the mint. Injected so tests need no network. */
export interface TerminalIdentityDeps {
  validateToken: (token: string) => Promise<{ valid?: boolean; state?: string } | null>
}

export function useTerminalIdentity(deps?: TerminalIdentityDeps): TerminalIdentity {
  /**
   * The mint client, held in a ref rather than depended on.
   *
   * A caller passing an inline object — the obvious way to write it — would
   * give the effect a new identity every render and loop forever. Found by a
   * mutation control that made `deps` unused and turned the loop into an
   * out-of-memory crash rather than a failing assertion, which is exactly how
   * this would present in a browser: a tab that grinds to a halt with no error
   * anyone can read.
   *
   * The effect should run once per DEVICE, not once per render, so the
   * identity of the client is not what decides that.
   */
  const mint = useRef(deps)

  const [identity, setIdentity] = useState<TerminalIdentity>(() => {
    // Synchronous on the owner's device: no credential, nothing to check, and
    // no reason to make the till wait for an answer that cannot change.
    const stored = storedTerminal()
    return stored?.token ? { ...OWNER, ready: false } : OWNER
  })

  // Kept current in an EFFECT, not during render: writing a ref while
  // rendering is unsafe under concurrent React, and the lint says so.
  useEffect(() => {
    mint.current = deps
  }, [deps])

  useEffect(() => {
    const stored = storedTerminal()
    // No credential means the owner's own device, and so does a pre-ticket-10
    // record that predates the credential being stored: both behave exactly as
    // the app always has, rather than becoming a terminal that cannot log in.
    //
    // Returns rather than setting state: the lazy initialiser has ALREADY
    // resolved this case to OWNER, so setting it again would be a cascading
    // render that changes nothing.
    if (!stored?.token || !stored.merchantMetadata || !stored.issuerId) return

    // Captured here rather than read inside the async closure, where
    // TypeScript can no longer see the guard above.
    const { token, merchantMetadata, issuerId, terminalPubkey } = stored

    let cancelled = false

    void (async () => {
      /**
       * The mint's answer, if we can get one.
       *
       * `null` on any failure, which `loginTerminal` reads as "could not ask"
       * and admits on reduced authority. Failing closed here would take a
       * stall off the market every time its connection dropped.
       */
      const api = mint.current
      const unspent = api ? unspentForLogin(await credentialState(token, api)) : null

      if (cancelled) return

      const outcome: LoginOutcome = loginTerminal({
        merchantMetadata,
        issuerId,
        devicePubkey: terminalPubkey,
        unspent,
      })

      setIdentity(
        outcome.admitted
          ? { actor: outcome.actor, session: outcome.session, refusal: null, ready: true }
          : { actor: null, session: null, refusal: outcome.message, ready: true },
      )
    })()

    return () => {
      cancelled = true
    }
    // Empty: one login per device, at launch. Re-running on a changed client
    // would re-verify a credential that has not changed.
  }, [])

  return identity
}
