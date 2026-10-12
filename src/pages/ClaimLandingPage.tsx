import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'

import { fetchClaimSummary, redeemClaimRef, type ClaimSummary, type RedeemResult } from '../lib/cashback'
import { currencyDecimals, formatFace, shortPubkey } from '../lib/format'
import { humanName, useIdentityState } from '../lib/identity'
import { hasStoredKey } from '../lib/nap'
import { clearPendingClaim, markPendingClaimOffered, peekPendingClaim, pendingClaimToResume, stashPendingClaim, takePendingClaim } from '../lib/pendingClaim'
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

/** The pattern a cashback claim key has: 32 bytes, base64url, unpadded. */
const KEY_IN_FRAGMENT = /[#&]k=([A-Za-z0-9_-]+)/
/** A whole key, as `redeemClaimRef` requires it (`CLAIM_KEY_RE`). */
const WHOLE_KEY = /^[A-Za-z0-9_-]{43}$/
/** An x-only public key, as the portal returns the issuer. */
const PUBKEY_HEX = /^[0-9a-f]{64}$/

/**
 * Read the arrival ONCE, synchronously, and take the key out of the address bar before anything
 * else happens (claim links phase 1). The key then lives only in this component's memory (and in
 * the parked claim, for a resume): never in a URL query, never in a log line, never in a request.
 */
function readArrival(ref: string | undefined): Arrival {
  const match = KEY_IN_FRAGMENT.exec(window.location.hash)
  scrubFragment()
  if (ref && match) {
    // A key of the wrong length is a truncated link, not a claim: never park it or offer Add.
    return WHOLE_KEY.test(match[1]) ? { kind: 'link', ref, key: match[1] } : { kind: 'incomplete' }
  }

  // A claim parked before onboarding or login arrives with no fragment at all, so a bare visit is
  // not necessarily a broken link.
  const pending = peekPendingClaim()
  if (pending) {
    if (WHOLE_KEY.test(pending.key)) return { kind: 'resumed', ref: pending.ref, key: pending.key }
    // Parked before this check existed. `/` would bounce back here for as long as it is parked.
    clearPendingClaim()
  }

  return { kind: 'incomplete' }
}

/**
 * Forget the parked claim, but only if it is THIS one: a newer link parked meanwhile is left alone.
 *
 * Every dead end (claimed, expired, revoked, own cashback, not found, a bad key) must call this
 * before going home, because `/` sends a device with a parked claim straight back to `/c`. Left
 * parked, a dead claim held the customer on this screen until it aged out (24 h).
 */
function forgetIfParked(ref: string): void {
  if (peekPendingClaim()?.ref === ref) clearPendingClaim()
}

/**
 * `/`: a parked claim first, otherwise the home screen (`children`).
 *
 * A component rather than a condition in `App.tsx`'s route table, because a route's `element` is
 * built when the PARENT renders, and `AuthedApp` does not re-render on navigation. As a condition,
 * the answer was whatever it had been at `AuthedApp`'s last render: "Open my wallet" from the prompt
 * bounced back to `/c` (and, after a successful Accept, to a "link is incomplete" screen) until
 * something unrelated re-rendered the app. Here it is decided each time `/` is entered.
 *
 * Once per page session and account (`pendingClaimToResume`): the prompt's own way home must reach
 * home. A claim still waiting is offered again on the next launch or unlock.
 */
export function ResumeParkedClaim({ pubkey, children }: { pubkey: string; children: ReactNode }) {
  return pendingClaimToResume(pubkey) ? <Navigate to="/c" replace /> : <>{children}</>
}

/**
 * Landing a bearer claim link, with or without a session.
 *
 * The hosted claim page never redeems anything: it hands over the claim reference and the key
 * from its fragment and lets the wallet do it. This is where that hand-off arrives.
 *
 * - **With a session: the confirm prompt** (docs/spec-claim-links.md 4.3, phase 1). Opening the
 *   link NEVER redeems it. The page reads the portal's public metadata, which is not destructive,
 *   and shows the stall (resolved from the issuer), the face value and the claim-by date, and what
 *   it could verify. Only **Add to my wallet** spends, exactly once. **Decline** forgets the parked
 *   claim on this device and leaves the voucher unclaimed for its funder to revoke or let lapse.
 *   It used to redeem on load, so a prefetch, a link preview, a tab restore or a mis-tap in a
 *   logged-in browser spent the voucher.
 * - **Without a session.** Park the claim, scrub the fragment, and send them to Login if this
 *   device holds a key (a returning customer) or to onboarding if it does not; a terminal goes to
 *   its till. `/` resumes the parked claim, to this same prompt, once the session opens.
 *
 * ## The key is read from the fragment and then removed
 *
 * A fragment never reaches a server, which is why the key travels there. It is stripped from the
 * address bar with `history.replaceState` in the first render, before any await, so it does not
 * survive in history, a bookmark, a screenshot of the URL bar or a referrer. Pinned by
 * `ClaimLandingPrompt.test.tsx`, which also asserts it never reaches a log line or a request URL.
 */
export function ClaimLandingPage({ authed, pubkey }: { authed: boolean; pubkey?: string }) {
  const { ref } = useParams<{ ref: string }>()
  const navigate = useNavigate()

  // Read once per mount, in the first render: React may render twice (StrictMode) and the second
  // read would find the fragment already scrubbed.
  const [arrival] = useState<Arrival>(() => readArrival(ref))
  const started = useRef(false)

  useEffect(() => {
    if (authed || arrival.kind === 'incomplete') return
    if (started.current) return
    started.current = true

    // A terminal is not a customer: it never parks a claim, and its key must never reach
    // /login, where it would open a customer session (#160 spec 2.3). Its till, as `Entry`.
    if (isTerminalDevice()) {
      navigate('/terminal/unlock', { replace: true })
      return
    }
    // Park it before the first await. Nothing is spent by any of this (claim links, phase 0).
    stashPendingClaim(arrival.ref, arrival.key)
    // Route by DEVICE (spec 1.6, 2.5). A device that holds a key belongs to someone with an
    // account whose session ended: they unlock, they do not register again. Anyone else gets
    // a wallet first. Either way `/` resumes the parked claim after the session opens.
    void hasStoredKey().then(
      (has) => navigate(has ? '/login' : '/onboarding', { replace: true }),
      () => navigate('/onboarding', { replace: true }),
    )
  }, [arrival, authed, navigate])

  const goHome = useCallback(() => navigate('/', { replace: true }), [navigate])

  if (arrival.kind === 'incomplete') {
    return (
      <Outcome
        title="Voucher unavailable"
        body="This link is incomplete. Ask for it again, or scan the whole QR."
        onDone={goHome}
      />
    )
  }
  if (!authed) return <Centered>Opening your voucher…</Centered>

  return <ConfirmPrompt arrival={arrival} pubkey={pubkey} onDone={goHome} />
}

type PromptState =
  | { step: 'loading' }
  | { step: 'summary'; summary: ClaimSummary }
  | { step: 'redeeming' }
  | { step: 'done'; result: RedeemResult }

/**
 * The confirm prompt: what the voucher is, who it is from, what could be verified, and the one
 * button that spends it.
 */
function ConfirmPrompt({
  arrival,
  pubkey,
  onDone,
}: {
  arrival: Extract<Arrival, { ref: string }>
  pubkey: string | undefined
  onDone: () => void
}) {
  const [state, setState] = useState<PromptState>({ step: 'loading' })
  /** Redeeming is DESTRUCTIVE: a second tap, or a re-render, must never start a second claim. */
  const spending = useRef(false)

  // Shown now, so `/` does not send the customer back here when they leave it this session.
  useEffect(() => markPendingClaimOffered(arrival.ref, pubkey), [arrival.ref, pubkey])

  const fetchSummary = useCallback(() => {
    let live = true
    void fetchClaimSummary(arrival.ref).then(
      (summary) => live && setState({ step: 'summary', summary }),
      () => live && setState({ step: 'summary', summary: { kind: 'unreachable' } }),
    )
    return () => {
      live = false
    }
  }, [arrival.ref])

  // The state starts at `loading`, so the first read only fetches. Retry resets it first.
  useEffect(() => fetchSummary(), [fetchSummary])
  const load = useCallback(() => {
    setState({ step: 'loading' })
    fetchSummary()
  }, [fetchSummary])

  const issuer = state.step === 'summary' && state.summary.kind === 'ok' ? state.summary.issuerPubkey : null
  const { identity, loading: stallLoading } = useIdentityState(issuer && PUBKEY_HEX.test(issuer) ? issuer : undefined)
  const stallName = humanName(identity?.name)

  const accept = useCallback(() => {
    if (spending.current) return
    spending.current = true
    setState({ step: 'redeeming' })
    void redeemClaimRef(arrival.ref, arrival.key).then((result) => {
      if (result.kind === 'ok' || result.kind === 'not_found' || result.kind === 'terminal'
        || result.kind === 'held' || result.kind === 'refused') {
        // Spent, or gone for good. Either way there is nothing left to resume, and keeping it
        // would offer a dead claim to the next visit. (`held` and `refused` keep the TOKEN in the
        // cashback stash; the claim itself is spent.)
        takePendingClaim()
      } else if (result.kind === 'invalid') {
        // Nothing a retry could fix: do not park it, and drop it if it was parked.
        forgetIfParked(arrival.ref)
      } else if (arrival.kind === 'link') {
        // Failed before the claim was spent, and the key came from the URL rather than the
        // store. Park it so a retry has something to work from.
        stashPendingClaim(arrival.ref, arrival.key)
      }
      setState({ step: 'done', result })
    })
  }, [arrival])

  /** A dead end: nothing here can ever be added, so it must not stay parked (see `forgetIfParked`). */
  const finish = useCallback(() => {
    forgetIfParked(arrival.ref)
    onDone()
  }, [arrival.ref, onDone])

  const decline = useCallback(() => {
    // On this device only. The voucher is untouched at the server: its funder can still revoke
    // it, or it lapses at its expiry. Nobody is told anything.
    clearPendingClaim()
    onDone()
  }, [onDone])

  if (state.step === 'loading') return <Centered>Checking your voucher…</Centered>
  if (state.step === 'redeeming') return <Centered>Adding your voucher…</Centered>

  if (state.step === 'done') {
    const { result } = state
    if (result.kind === 'ok') {
      const face = result.amountMinor !== null && result.unit
        ? formatFace(result.amountMinor, { unit: result.unit, decimals: currencyDecimals(result.unit) })
        : null
      return (
        <Outcome
          title="Voucher added"
          body={face ? `${face}${stallName ? ` from ${stallName}` : ''} is in your wallet.` : 'It is in your wallet now.'}
          onDone={onDone}
        />
      )
    }
    return <Outcome title="Voucher unavailable" body={describe(result)} onDone={onDone} />
  }

  const { summary } = state
  if (summary.kind === 'unreachable') {
    return (
      <Outcome
        title="Voucher waiting"
        body="We could not reach the voucher service. Your voucher is still waiting."
        action={{ label: 'Retry', run: load }}
        onDone={onDone}
      />
    )
  }
  if (summary.kind === 'not_found') {
    return <Outcome title="Voucher unavailable" body="We could not find this voucher. Check the link is complete." onDone={finish} />
  }
  if (summary.kind === 'disabled') {
    return <Outcome title="Voucher unavailable" body="This wallet cannot claim vouchers yet." onDone={onDone} />
  }

  const issuerKey = summary.issuerPubkey
  const issuerWellFormed = issuerKey !== null && PUBKEY_HEX.test(issuerKey)
  // While the stall's profile is still on its way, say so rather than flash "Unknown stall" and an
  // unverified warning at a voucher that is about to verify.
  const stall = stallName ?? (stallLoading ? 'Checking the stall…' : 'Unknown stall')
  const closed = closedState(summary, stall)
  if (closed) return <Outcome title="Voucher unavailable" body={closed} onDone={finish} />

  // The merchant's own cashback (spec 3.2): receiving it would declare a credit for a coupon that
  // never left home. Refused before the tap, so nothing is redeemed.
  if (pubkey && issuerKey && pubkey.toLowerCase() === issuerKey) {
    return (
      <Outcome
        title="Your own cashback"
        body="This is your stall's own cashback. Give it to a customer, or cancel it."
        onDone={finish}
      />
    )
  }

  // What can be verified before the tap (spec 4.3). The metadata came from this deployment's own
  // portal; the issuer must be a well-formed key that resolves to a published stall; and this
  // wallet must trust a mint. The voucher's signature and its mint are checked on Accept by the
  // redeem, which holds a token at a mint it does not trust rather than crediting it.
  const verified = issuerWellFormed && stallName !== undefined
  const canAdd = issuerWellFormed && summary.mintTrusted
  const face = summary.amountMinor !== null && summary.unit
    ? formatFace(summary.amountMinor, { unit: summary.unit, decimals: summary.decimals ?? currencyDecimals(summary.unit) })
    : null

  return (
    <Centered>
      <div className="materialize w-full max-w-sm px-6 text-center" data-testid="claim-prompt">
        <p className="text-[15px] font-medium text-mono-900 dark:text-mono-50">{stall}</p>
        {stallLoading && !stallName ? (
          <p className="text-sm text-mono-400">Checking who issued this voucher…</p>
        ) : (
          <p className={verified ? 'text-sm text-emerald-600' : 'text-sm text-amber-600'}>
            {verified ? '✓ verified stall' : 'We could not verify this voucher'}
          </p>
        )}
        {!stallName && issuerWellFormed && <p className="text-xs text-mono-400">{shortPubkey(issuerKey)}</p>}
        {face && <p className="mt-4 text-amount text-mono-900 dark:text-mono-50">{face}</p>}
        <p className="mt-1 text-sm text-mono-500">Cashback from {stall}</p>
        {summary.memo && <p className="mt-1 text-sm text-mono-500">{summary.memo}</p>}
        {summary.expiresAt && <p className="mt-1 text-sm text-mono-500">Claim by {formatDate(summary.expiresAt)}</p>}
        <p className="mt-3 text-sm text-mono-500">Adding to your wallet</p>
        {!summary.mintTrusted && (
          <p className="mt-3 text-sm text-amber-600">
            This wallet has no trusted mint yet, so it cannot add vouchers. Your voucher is still waiting.
          </p>
        )}
        <Button size="lg" className="mt-6 w-full" disabled={!canAdd} onClick={accept}>
          Add to my wallet
        </Button>
        <Button size="lg" variant="ghost" className="mt-2 w-full" onClick={decline}>
          Decline
        </Button>
      </div>
    </Centered>
  )
}

/** The copy for a voucher that can no longer be added, or null while it can (spec 4.3). */
function closedState(summary: Extract<ClaimSummary, { kind: 'ok' }>, stall: string): string | null {
  switch (summary.status) {
    case 'Claimed':
      return summary.claimedAt
        ? `This voucher was already added to a wallet on ${formatDate(summary.claimedAt)}. If that was you on another device, it is there.`
        : 'This voucher was already added to a wallet. If that was you on another device, it is there.'
    case 'Expired':
      return summary.expiresAt ? `This voucher expired on ${formatDate(summary.expiresAt)}.` : 'This voucher has expired.'
    case 'Revoked':
      return `${stall} cancelled this voucher.`
    case 'Unclaimed':
      if (summary.expiresAt && Date.parse(summary.expiresAt) <= Date.now()) {
        return `This voucher expired on ${formatDate(summary.expiresAt)}.`
      }
      return null
    default:
      return 'This voucher is no longer claimable.'
  }
}

function formatDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
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
 * One component for every outcome rather than near-identical blocks: a customer who succeeds and
 * one who does not are looking at the same screen with different words.
 *
 * Centred and short. There is one thing to do here (two with Retry), and a page with one action
 * should not make somebody find it.
 */
function Outcome({
  title,
  body,
  onDone,
  action,
}: {
  title: string
  body: string
  onDone: () => void
  action?: { label: string; run: () => void }
}) {
  return (
    <Centered>
      {/* `materialize` because this arrives over a blank screen after a wait,
          and a plain cut reads as a page that failed to load and then did not.
          Reduced motion drops it through the shared rule in index.css. */}
      <div className="materialize max-w-sm px-6 text-center">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-mono-500">{body}</p>
        {action && (
          <Button size="lg" className="mt-6 w-full" onClick={action.run}>
            {action.label}
          </Button>
        )}
        <Button size="lg" variant={action ? 'ghost' : 'primary'} className={action ? 'mt-2 w-full' : 'mt-6 w-full'} onClick={onDone}>
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
      return 'This link is incomplete. Ask for it again, or scan the whole QR.'
    case 'disabled':
      return 'This wallet cannot claim vouchers yet.'
    case 'terminal':
      return result.code === 'claimed'
        ? 'This voucher was already added to a wallet. If that was you on another device, it is there.'
        : result.code === 'expired'
          ? 'This voucher has expired.'
          : 'The stall cancelled this voucher.'
    case 'throttled':
      return 'Too many attempts from this network. Your voucher is still waiting; try again shortly.'
    case 'held':
      return 'Your voucher is saved on this phone and waiting to be verified. Nothing was lost: it is added once its mint is confirmed.'
    case 'refused':
      return 'Your voucher is saved on this phone but could not be added to this wallet. Nothing was lost.'
  }
}
