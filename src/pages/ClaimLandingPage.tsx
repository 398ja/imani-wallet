import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { redeemClaimRef, type RedeemResult } from '../lib/cashback'
import { hasStoredKey } from '../lib/nap'
import { peekPendingClaim, stashPendingClaim, takePendingClaim } from '../lib/pendingClaim'
import { isTerminalDevice } from '../lib/terminalEnrol'
import { Button } from '../components/ui'
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
 * - **Without a session.** Park the claim, scrub the fragment, and send them to
 *   Login if this device holds a key (a returning customer) or to onboarding if
 *   it does not; a terminal goes to its till. Pick the claim up afterwards.
 *   Nothing is spent in the meantime, so leaving to sign in costs them nothing.
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
      // A terminal is not a customer: it never parks a claim, and its key must never reach
      // /login, where it would open a customer session (#160 spec 2.3). Its till, as `Entry`.
      if (isTerminalDevice()) {
        scrubFragment()
        navigate('/terminal/unlock', { replace: true })
        return
      }
      // Park it, and take the key out of the address bar, BEFORE the first await: the key-store
      // read below is async, and nothing may be left holding the key in the URL meanwhile.
      // Nothing is spent by any of this (claim links, phase 0).
      stashPendingClaim(arrival.ref, arrival.key)
      scrubFragment()
      // Route by DEVICE (spec 1.6, 2.5). A device that holds a key belongs to someone with an
      // account whose session ended: they unlock, they do not register again. Anyone else gets
      // a wallet first. Either way `/` resumes the parked claim after the session opens.
      void hasStoredKey().then(
        (has) => navigate(has ? '/login' : '/onboarding', { replace: true }),
        () => navigate('/onboarding', { replace: true }),
      )
      return
    }

    /*
     * Redeem FIRST, then forget.
     *
     * The previous order consumed the parked claim and stripped the fragment
     * before the redeem was attempted, so a network failure destroyed both
     * copies of the key while the screen told the customer their voucher was
     * still waiting. It was not: nothing could reach it again.
     *
     * The claim itself is unharmed by a failed redeem — the server only spends
     * it on a successful ciphertext fetch — so the key is the only thing worth
     * protecting, and it is dropped only once it is no longer needed.
     */
    void redeemClaimRef(arrival.ref, arrival.key).then((outcome) => {
      if (outcome.kind === 'ok' || outcome.kind === 'not_found') {
        // Spent, or gone for good. Either way there is nothing left to resume,
        // and keeping it would offer a dead claim to the next visit.
        takePendingClaim()
        window.history.replaceState(null, '', window.location.pathname)
      } else if (arrival.kind === 'link') {
        // Failed, and the key came from the URL rather than the store. Park it
        // so a retry has something to work from: the customer may close this
        // tab and come back to a link whose fragment they no longer have.
        stashPendingClaim(arrival.ref, arrival.key)
      }
      setResult(outcome)
    })
  }, [arrival, authed, navigate])

  if (arrival.kind === 'incomplete') {
    return (
      <Outcome
        title="Voucher unavailable"
        body="This link is missing part of itself. Make sure the whole QR was scanned."
        onDone={() => navigate('/', { replace: true })}
      />
    )
  }

  if (!result) return <Centered>Adding your voucher…</Centered>

  return result.kind === 'ok' ? (
    <Outcome
      title="Voucher added"
      body="It is in your wallet now."
      onDone={() => navigate('/', { replace: true })}
    />
  ) : (
    <Outcome
      title="Voucher unavailable"
      body={describe(result)}
      onDone={() => navigate('/', { replace: true })}
    />
  )
}

/** Drop the fragment (the claim key) from the address bar and from this history entry. */
function scrubFragment(): void {
  if (window.location.hash) {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }
}

/**
 * The end of the journey, whichever end it is.
 *
 * One component for both outcomes rather than three near-identical blocks: a
 * customer who succeeds and one who does not are looking at the same screen
 * with different words, and building them separately is how the failure case
 * ends up with the unstyled heading nobody noticed.
 *
 * Centred and short. There is exactly one thing to do here, and a page with one
 * action should not make somebody find it.
 */
function Outcome({
  title,
  body,
  onDone,
}: {
  title: string
  body: string
  onDone: () => void
}) {
  return (
    <Centered>
      {/* `materialize` because this arrives over a blank screen after a wait,
          and a plain cut reads as a page that failed to load and then did not.
          Reduced motion drops it through the shared rule in index.css. */}
      <div className="materialize max-w-sm px-6 text-center">
        {/* Tracking tightened, leading pulled in: both are size-specific, and a
            heading set with body defaults reads loose and airy. */}
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-mono-500">{body}</p>
        <Button size="lg" className="mt-6 w-full" onClick={onDone}>
          Open my wallet
        </Button>
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
