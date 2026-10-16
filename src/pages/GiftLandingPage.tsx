import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { currencyDecimals, formatFace, handleLabel, shortPubkey } from '../lib/format'
import {
  linkPubOf,
  parseGiftFragment,
  secretFromText,
  type GiftSummary,
  type GiftToken,
  type GiftVerdict,
} from '../lib/giftLink'
import { readGift, redeemGiftTokens, type GiftRedeemOutcome } from '../lib/giftLinks'
import { MERCHANT_FOREIGN_VOUCHER, MERCHANT_STATUS_UNKNOWN } from '../lib/merchantVouchers'
import { useForeignVoucherRole } from '../lib/useForeignVoucherRole'
import { humanName, useIdentityState } from '../lib/identity'
import { hasStoredKey } from '../lib/nap'
import { loadProfile } from '../lib/profile'
import {
  forgetPendingClaim,
  listPendingClaims,
  markPendingClaimOffered,
  pendingClaimToResume,
  stashPendingClaim,
} from '../lib/pendingClaim'
import { isTerminalDevice } from '../lib/terminalEnrol'
import { Button } from '../components/ui'
import { Centered } from '../components/ui/layout'
import { Outcome } from './ClaimLandingPage'

/**
 * A gift link arriving at the wallet: `/g#v=1&k=<linkSecret>&x=<expiry>` (claim links phase 4,
 * spec 3.3 claim, 4.3, 5.3, 5.4).
 *
 * The same rules as `/c` (`ClaimLandingPage`), which this mirrors:
 * - the fragment is read ONCE in the first render and scrubbed with `history.replaceState` before
 *   any await, parked or not;
 * - with no session the claim is parked (kind `gift`, keyed by the link's PUBLIC key) and the
 *   visitor goes to Login or onboarding by device; `/` resumes it after the session opens;
 * - with a session, the prompt: everything on it comes from the token itself, verified BEFORE
 *   anything is spent (issuer signature, trusted mint, not a licence or credential, not past `x`,
 *   every proof unspent by NUT-07). Only **Add to my wallet** spends, once.
 *
 * The secret is in memory and in the parked claim only. It is never logged, rendered, or sent: the
 * wrap query carries the derived public key, signed NIP-98 by the link key and never by the
 * visitor, with credentials omitted.
 */
type Arrival =
  | { kind: 'link'; ref: string; key: string; x: number }
  | { kind: 'resumed'; ref: string; key: string; x: number }
  | { kind: 'incomplete' }

function readArrival(pubkey: string | undefined): Arrival {
  const parsed = parseGiftFragment(window.location.hash)
  const hadFragment = window.location.hash.length > 1
  scrubFragment()
  if (hadFragment) {
    return parsed.kind === 'gift'
      ? { kind: 'link', ref: linkPubOf(parsed.secret), key: parsed.key, x: parsed.x }
      : { kind: 'incomplete' }
  }
  // A gift parked before onboarding or login: the same bounded walk as `/c`, gifts only.
  const tried = new Set<string>()
  const next = () => pendingClaimToResume(pubkey, 'gift')
    ?? listPendingClaims().reverse().find((e) => e.kind === 'gift' && !tried.has(e.ref))
    ?? null
  for (let pending = next(); pending && !tried.has(pending.ref); pending = next()) {
    if (secretFromText(pending.key) && typeof pending.x === 'number') {
      return { kind: 'resumed', ref: pending.ref, key: pending.key, x: pending.x }
    }
    tried.add(pending.ref)
    markPendingClaimOffered(pending.ref, pubkey)
    forgetPendingClaim(pending.ref)
  }
  return { kind: 'incomplete' }
}

function scrubFragment(): void {
  if (window.location.hash) {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }
}

export function GiftLandingPage({
  authed,
  pubkey,
  onSwitchAccount,
}: {
  authed: boolean
  pubkey?: string
  onSwitchAccount?: () => void
}) {
  const navigate = useNavigate()
  const [arrival] = useState<Arrival>(() => readArrival(pubkey))
  const started = useRef(false)

  useEffect(() => {
    if (authed || arrival.kind === 'incomplete') return
    if (started.current) return
    started.current = true
    if (isTerminalDevice()) {
      navigate('/terminal/unlock', { replace: true })
      return
    }
    stashPendingClaim(arrival.ref, arrival.key, { kind: 'gift', x: arrival.x })
    void hasStoredKey().then(
      (has) => navigate(has ? '/login' : '/onboarding', { replace: true }),
      () => navigate('/onboarding', { replace: true }),
    )
  }, [arrival, authed, navigate])

  const goHome = useCallback(() => navigate('/', { replace: true }), [navigate])

  if (arrival.kind === 'incomplete') {
    return <Outcome tone="unavailable" title="Voucher unavailable" body="This link is incomplete. Ask for it again, or scan the whole QR." onDone={goHome} />
  }
  if (!authed) return <Centered>Opening your voucher…</Centered>
  return <GiftPrompt arrival={arrival} pubkey={pubkey} onDone={goHome} onSwitchAccount={onSwitchAccount} />
}

type PromptState =
  | { step: 'loading' }
  | { step: 'ready'; verdict: GiftVerdict; tokens: GiftToken[] }
  | { step: 'redeeming' }
  | { step: 'done'; outcome: GiftRedeemOutcome; summary: GiftSummary }

function GiftPrompt({
  arrival,
  pubkey,
  onDone,
  onSwitchAccount,
}: {
  arrival: Extract<Arrival, { ref: string }>
  pubkey: string | undefined
  onDone: () => void
  onSwitchAccount?: () => void
}) {
  const [state, setState] = useState<PromptState>({ step: 'loading' })
  const spending = useRef(false)

  useEffect(() => markPendingClaimOffered(arrival.ref, pubkey), [arrival.ref, pubkey])

  const fetchGift = useCallback(() => {
    let live = true
    void readGift(arrival.key, arrival.x).then(
      ({ verdict, tokens }) => live && setState({ step: 'ready', verdict, tokens }),
      () => live && setState({ step: 'ready', verdict: { kind: 'unreachable' }, tokens: [] }),
    )
    return () => {
      live = false
    }
  }, [arrival.key, arrival.x])
  useEffect(() => fetchGift(), [fetchGift])
  const retry = useCallback(() => {
    // A failed receive may be retried: the redeem is idempotent per token at the ledger, and the
    // re-read verifies again (a token spent meanwhile reads as already claimed).
    spending.current = false
    setState({ step: 'loading' })
    fetchGift()
  }, [fetchGift])

  const summary =
    state.step === 'ready' && (state.verdict.kind === 'ok' || state.verdict.kind === 'expired')
      ? state.verdict.summary
      : state.step === 'done'
        ? state.summary
        : null
  const { identity: stallIdentity, loading: stallLoading } = useIdentityState(summary?.issuer)
  const { identity: senderIdentity } = useIdentityState(summary?.senderPubkey)
  const stallName = humanName(stallIdentity?.name)
  const senderName = humanName(senderIdentity?.name)
    ?? (senderIdentity?.nip05 ? handleLabel(senderIdentity.nip05) : undefined)
    ?? (summary?.senderPubkey ? shortPubkey(summary.senderPubkey) : 'someone')
  const [ownHandle] = useState(() => {
    const nip05 = pubkey ? loadProfile(pubkey)?.nip05 : undefined
    return nip05 ? handleLabel(nip05) : null
  })

  const finish = useCallback(() => {
    forgetPendingClaim(arrival.ref)
    onDone()
  }, [arrival.ref, onDone])

  // Owner rule 2026-10-13: a merchant account takes only its own stall's vouchers. The gift's stall
  // is the verified token's signed issuer, so this is decided before Add, with nothing spent. Only
  // asked for ANOTHER stall's coupon: a stall opening a gift of its own coupon is a redemption.
  const giftIssuer = state.step === 'ready' && state.verdict.kind === 'ok' ? state.verdict.summary.issuer : null
  const { role, retry: retryRole } = useForeignVoucherRole(pubkey, giftIssuer)

  const accept = useCallback(() => {
    if (spending.current || state.step !== 'ready' || state.verdict.kind !== 'ok') return
    spending.current = true
    // Only what verifyGift passed and found unspent: never a token a third party wrapped to the
    // link's public key, and never a part an earlier Add already took (review of #247, F1, F4).
    const { tokens } = state.verdict
    const verified = state.verdict.summary
    setState({ step: 'redeeming' })
    void redeemGiftTokens(tokens, 'gift_link').then(
      (outcome) => {
        if (outcome.kind === 'failed') {
          // Nothing a retry could not fix may have been spent; keep it parked so a retry can start.
          stashPendingClaim(arrival.ref, arrival.key, { kind: 'gift', x: arrival.x })
        } else {
          forgetPendingClaim(arrival.ref)
        }
        setState({ step: 'done', outcome, summary: verified })
      },
      (error: unknown) => {
        stashPendingClaim(arrival.ref, arrival.key, { kind: 'gift', x: arrival.x })
        setState({ step: 'done', outcome: { kind: 'failed', message: String(error) }, summary: verified })
      },
    )
  }, [arrival, state])

  if (state.step === 'loading') return <Centered>Checking your voucher…</Centered>
  if (state.step === 'redeeming') return <Centered>Adding your voucher…</Centered>

  if (state.step === 'done') {
    const face = formatFace(state.summary.faceMinor, { unit: state.summary.unit, decimals: state.summary.decimals ?? currencyDecimals(state.summary.unit) })
    switch (state.outcome.kind) {
      case 'ok':
        return <Outcome tone="success" title="Voucher added" body={`${face}${stallName ? ` from ${stallName}` : ''} is in your wallet.`} onDone={onDone} />
      case 'claimed':
        return <Outcome tone="unavailable" title="Voucher unavailable" body={ALREADY_CLAIMED} onDone={onDone} />
      case 'held':
        return <Outcome tone="unavailable" title="Voucher unavailable" body={UNTRUSTED_MINT} onDone={onDone} />
      case 'failed':
        return (
          <Outcome
            tone="waiting" title="Voucher waiting"
            body="We could not add it just now. Your voucher is still waiting, so please try again."
            action={{ label: 'Retry', run: retry }}
            onDone={onDone}
          />
        )
      case 'merchant_refused':
        return (
          <Outcome
            tone={state.outcome.reason === 'merchant' ? 'unavailable' : 'waiting'}
            title={state.outcome.reason === 'merchant' ? 'Not for a merchant account' : 'Voucher waiting'}
            body={state.outcome.reason === 'merchant' ? MERCHANT_FOREIGN_VOUCHER : MERCHANT_STATUS_UNKNOWN}
            onDone={onDone}
          />
        )
    }
  }

  const { verdict } = state
  switch (verdict.kind) {
    case 'unreachable':
      return (
        <Outcome
          tone="waiting" title="Voucher waiting"
          body="We could not reach the voucher service. Your voucher is still waiting."
          action={{ label: 'Retry', run: retry }}
          onDone={onDone}
        />
      )
    case 'claimed':
      return <Outcome tone="unavailable" title="Voucher unavailable" body={ALREADY_CLAIMED} onDone={finish} />
    case 'expired':
      return (
        <Outcome
          tone="unavailable" title="Voucher unavailable"
          body={`This voucher expired on ${formatDate(verdict.at)}. Ask ${senderName} to send it again.`}
          onDone={finish}
        />
      )
    case 'not_money':
      return <Outcome tone="unavailable" title="Voucher unavailable" body="This link does not contain a voucher." onDone={finish} />
    case 'untrusted_mint':
      return <Outcome tone="unavailable" title="Voucher unavailable" body={UNTRUSTED_MINT} onDone={finish} />
    case 'unverified':
      return <Outcome tone="unavailable" title="Voucher unavailable" body="We could not verify this voucher." onDone={finish} />
    case 'ok':
      break
  }

  if (role === 'checking') return <Centered>Checking your voucher…</Centered>
  if (role === 'merchant' || role === 'unknown') {
    return (
      <Outcome
        tone={role === 'merchant' ? 'unavailable' : 'waiting'}
            title={role === 'merchant' ? 'Not for a merchant account' : 'Voucher waiting'}
        body={role === 'merchant' ? MERCHANT_FOREIGN_VOUCHER : MERCHANT_STATUS_UNKNOWN}
        {...(role === 'unknown'
          ? { action: { label: 'Retry', run: retryRole } }
          : onSwitchAccount
            ? {
                action: {
                  label: 'Switch account',
                  run: () => {
                    // Kept parked: it resumes on the customer account after the next login.
                    stashPendingClaim(arrival.ref, arrival.key, { kind: 'gift', x: arrival.x })
                    onSwitchAccount()
                  },
                },
              }
            : {})}
        onDone={onDone}
      />
    )
  }

  const s = verdict.summary
  const stall = stallName ?? (stallLoading ? 'Checking the stall…' : 'Unknown stall')
  const face = formatFace(s.faceMinor, { unit: s.unit, decimals: s.decimals ?? currencyDecimals(s.unit) })
  const validFor = s.couponExpiresAt ? `Valid until ${formatDate(s.couponExpiresAt)} once added` : null

  return (
    <Centered>
      <div className="materialize w-full max-w-sm px-6 text-center" data-testid="gift-prompt">
        <p className="text-callout font-medium text-mono-900 dark:text-mono-50">{stall}</p>
        {/* green-700 rather than emerald-600: the lighter green measured about
            3.6:1 on the page background, under the 4.5:1 small text needs, on
            the one line that says this voucher can be trusted. */}
        <p className="text-sm text-green-700 dark:text-green-400">✓ verified stall</p>
        {!stallName && <p className="text-xs text-mono-500">{shortPubkey(s.issuer)}</p>}
        <p className="mt-4 text-amount text-mono-900 dark:text-mono-50">{face}</p>
        <p className="mt-1 text-sm text-mono-500">Cashlink from {senderName}</p>
        <p className="mt-1 text-sm text-mono-500">
          Claim by {formatDate(arrival.x)}
          {validFor ? ` · ${validFor}` : ''}
        </p>
        <p className="mt-3 text-sm text-mono-500">Adding to {ownHandle ?? 'your wallet'}</p>
        {onSwitchAccount && (
          <p className="mt-1 text-sm text-mono-500">
            Not you?{' '}
            <button
              type="button"
              // Padded to a usable target: as a bare inline word it was a
              // 20px-tall tap at the bottom of a prompt that also spends money.
              className="pressable -my-3 inline-block py-3 underline hover:text-mono-900 dark:hover:text-mono-50"
              onClick={() => {
                stashPendingClaim(arrival.ref, arrival.key, { kind: 'gift', x: arrival.x })
                onSwitchAccount()
              }}
            >
              Switch account
            </button>
          </p>
        )}
        <Button size="lg" className="mt-6 w-full" onClick={accept}>
          Add to my wallet
        </Button>
        <Button size="lg" variant="ghost" className="mt-2 w-full" onClick={finish}>
          Decline
        </Button>
      </div>
    </Centered>
  )
}

const ALREADY_CLAIMED = 'This voucher was already added to a wallet. If that was you on another device, it is there.'
const UNTRUSTED_MINT = 'This voucher is from a mint this wallet does not use.'

function formatDate(unixSeconds: number): string {
  const at = new Date(unixSeconds * 1000)
  if (Number.isNaN(at.getTime())) return String(unixSeconds)
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
}
