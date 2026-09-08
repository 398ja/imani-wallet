import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { redeemClaimRef, type RedeemResult } from '../lib/cashback'
import { peekPendingClaim, stashPendingClaim, takePendingClaim } from '../lib/pendingClaim'
import { Centered } from '../components/ui/layout'

/**
 * How this visit arrived, which decides what may be done with it.
 *
 * `resumed` and `link` carry the same two values and are distinguished anyway,
 * because they reach different people: one is a customer who just installed the
 * app, the other is someone opening a link with a wallet already in hand.
 */
type Arrival =
  | { kind: 'link'; ref: string; key: string }
  | { kind: 'resumed'; ref: string; key: string }
  | { kind: 'incomplete' }

/**
 * Landing a bearer claim link, with or without a wallet.
 *
 * The hosted claim page no longer redeems anything: it hands over the claim
 * reference and the key from its fragment and lets the wallet do it. This is
 * where that hand-off arrives.
 *
 * Two arrivals, one screen:
 *
 * - **With a wallet.** Redeem straight away and show the result.
 * - **Without one.** Park the claim, send them to onboarding, and pick it up
 *   afterwards. Nothing is spent in the meantime, so leaving to install the app
 *   costs them nothing.
 *
 * ## The key is read from the fragment and then removed
 *
 * A fragment never reaches a server, which is why the key travels there. It is
 * stripped from the address bar once read so it does not survive in history or
 * get shoulder-read off a URL bar. The redeem is single-use at the server
 * anyway, so a leaked key after the fact buys nothing; this is tidiness rather
 * than the security boundary.
 */
export function ClaimLandingPage({ authed }: { authed: boolean }) {
  const { ref } = useParams<{ ref: string }>()
  const navigate = useNavigate()
  const [result, setResult] = useState<RedeemResult | null>(null)
  /**
   * Redeeming is DESTRUCTIVE, and React runs effects twice in StrictMode. A
   * second call would meet a claimed claim and tell a customer their voucher
   * was already taken, moments after taking it for them.
   */
  const started = useRef(false)

  /**
   * What this visit is, decided during render rather than in the effect.
   *
   * The fragment and the parked claim are both readable synchronously, so the
   * kind of arrival is a property of the render, not a state transition. Doing
   * it here keeps the effect to the one thing that genuinely is a side effect:
   * spending the claim.
   */
  const arrival = useMemo((): Arrival => {
    const match = /[#&]k=([A-Za-z0-9_-]+)/.exec(window.location.hash)
    if (ref && match) return { kind: 'link', ref, key: match[1] }

    // A claim parked before onboarding arrives with no fragment at all, so a
    // bare visit is not necessarily a broken link.
    const pending = peekPendingClaim()
    if (pending) return { kind: 'resumed', ref: pending.ref, key: pending.key }

    return { kind: 'incomplete' }
  }, [ref])

  useEffect(() => {
    if (arrival.kind === 'incomplete') return
    if (started.current) return
    started.current = true

    if (!authed) {
      // Park it and go and get a wallet. Nothing is spent by doing this.
      stashPendingClaim(arrival.ref, arrival.key)
      navigate('/onboarding', { replace: true })
      return
    }

    // Consume the parked copy now that this render is committed to spending it,
    // and drop the key from the address bar.
    takePendingClaim()
    window.history.replaceState(null, '', window.location.pathname)
    void redeemClaimRef(arrival.ref, arrival.key).then(setResult)
  }, [arrival, authed, navigate])

  if (arrival.kind === 'incomplete') {
    return (
      <Centered>
        <div>
          <h1>Voucher unavailable</h1>
          <p>This link is missing part of itself. Make sure the whole QR was scanned.</p>
          <button onClick={() => navigate('/', { replace: true })}>Open my wallet</button>
        </div>
      </Centered>
    )
  }

  if (!result) return <Centered>Adding your voucher…</Centered>

  if (result.kind === 'ok') {
    return (
      <Centered>
        <div>
          <h1>Voucher added</h1>
          <p>It is in your wallet now.</p>
          <button onClick={() => navigate('/', { replace: true })}>Open my wallet</button>
        </div>
      </Centered>
    )
  }

  return (
    <Centered>
      <div>
        <h1>Voucher unavailable</h1>
        <p>{describe(result)}</p>
        <button onClick={() => navigate('/', { replace: true })}>Open my wallet</button>
      </div>
    </Centered>
  )
}

/**
 * Wording a customer can act on, and nothing they cannot.
 *
 * `unreachable` is deliberately hopeful: the claim is untouched when the
 * network fails, so telling someone to try again is true rather than kind.
 */
function describe(result: Exclude<RedeemResult, { kind: 'ok' }>): string {
  switch (result.kind) {
    case 'unreachable':
      return 'We could not reach the voucher service. Your voucher is still waiting, so please try again.'
    case 'not_found':
      return 'We could not find this voucher. Check the link is complete.'
    case 'invalid':
      return 'This link is missing part of itself. Make sure the whole QR was scanned.'
    case 'disabled':
      return 'This wallet cannot claim vouchers yet.'
    default:
      return 'This voucher is no longer claimable.'
  }
}
