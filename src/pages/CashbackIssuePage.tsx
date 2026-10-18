import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'

import { CancelCashback, ClaimLinkPanel } from '../components/CashbackClaimLink'

import { Button, Screen, BackLink, PageHeader, Alert, Panel, Input } from '../components/ui'
import type { IssuedCashback } from '../lib/cashback'
import { createCashbackIssuer } from '../lib/cashbackIssue'
import { useLiveCashbackStatus } from '../lib/cashbackLiveStatus'
import { formatCashbackLink } from '../lib/claimLink'
import { gatewayConfig, DEFAULT_CASHBACK_EXPIRY_DAYS } from '../lib/config'
import { currencyDecimals, formatDate, formatFace, parseAmountToMinor } from '../lib/format'
import type { MerchantProfile } from '../lib/merchant'
import { NOTE_MAX_CHARS, clampNote } from '../lib/note'
import { ownerActor, type Actor } from '../lib/actor'
import type { TerminalSession } from '../lib/terminalSession'
import { TERMINAL_CASHBACK_UNSUPPORTED, mayWarrantSale } from '../lib/warrantSigner'
import { userMessage } from '../lib/userMessage'

/**
 * Create a Cashlink (the stall's cashback): a coupon for someone who has not installed the app.
 *
 * The counterpart to Sell, and the difference is who has to be present. Sell needs the customer
 * standing there with a wallet to scan; this needs only their phone camera. The merchant types an
 * amount, shows the QR or shares the link, and the customer claims it on a phone that may not have
 * the app yet. Typed codes are retired (wallet#268): the screen shows no code.
 *
 * No recipient step: whoever holds the link gets the money, which is the trade being made for
 * reaching someone who cannot yet be addressed.
 */
export function CashbackIssuePage({
  merchant,
  actor,
  session,
}: {
  merchant: MerchantProfile
  /**
   * The terminal issuing, if this device is one.
   *
   * Passed for the same reason `SellPage` takes it: a warrant must be signed
   * by the key it names, and a terminal's key is not the stall's. Absent means
   * the stall's own device.
   */
  actor?: Actor
  /** The terminal's session, which decides whether it may issue now. Absent for the owner. */
  session?: TerminalSession | null
}) {
  const navigate = useNavigate()
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedCashback | null>(null)
  // One issuer for the life of this screen: it ignores a press while one is in
  // flight, and keeps the key and warrant across a failure so pressing again
  // retries the same sale (#144). See `createCashbackIssuer`.
  const [issuer] = useState(createCashbackIssuer)
  // Deployment policy, not a merchant choice, so it is read rather than picked.
  // Shown before the merchant commits, because "how long do they have?" is the
  // question a customer asks at the counter and the answer must not be a guess.
  const [expiryDays, setExpiryDays] = useState(DEFAULT_CASHBACK_EXPIRY_DAYS)

  useEffect(() => {
    let live = true
    void gatewayConfig().then(
      (config) => {
        if (live) setExpiryDays(config.cashbackExpiryDays)
      },
      () => {
        // Keep the default. A config read that failed is not a reason to block
        // issuing — the gateway applies its own term regardless of what we say.
      },
    )
    return () => {
      live = false
    }
  }, [])

  const decimals = currencyDecimals(merchant.issuanceCurrency)
  const minor = parseAmountToMinor(amount, decimals)

  const submit = async () => {
    if (minor === null || busy) return
    setBusy(true)
    setError(null)
    // Set only by the press that actually ran. A press the issuer dropped must
    // not clear `busy` while the real one is still waiting on the portal.
    let ran = true
    try {
      // Signs the warrant BEFORE minting, then records the same string. See
      // `cashbackIssue.ts` for why the order matters.
      const cashback = await issuer.submit({
        actor: actor ?? ownerActor(merchant.pubkey),
        session,
        amountMinor: minor,
        unit: merchant.issuanceCurrency,
        decimals,
        memo: clampNote(memo.trim() || undefined),
        expiryDays,
        // The coupon ages out on the stall's term, as a Sell coupon does
        // (398ja/imani-gateway-portal#58). `expiryDays` above is only the claim window.
        voucherValidityDays: merchant.voucherValidityDays,
      })
      // Null: a second press while the first was in flight. The first one
      // owns the outcome, so this one changes nothing.
      if (cashback) setIssued(cashback)
      else ran = false
    } catch (e) {
      setError(userMessage(e))
    } finally {
      if (ran) setBusy(false)
    }
  }

  /*
    A terminal cannot sign a warrant the stall's till accepts, so its cashback
    coupon would be refused when the customer came to spend it (#159). Stopped
    on arrival, before an amount is typed or a code is minted; `cashbackIssue`
    refuses the same request made around this screen.
  */
  if (actor && !mayWarrantSale(actor, session ?? null)) {
    return (
      <Screen>
        <BackLink to="/" label="Back" />
        <PageHeader title="Cashlink" />
        <Alert>{TERMINAL_CASHBACK_UNSUPPORTED}</Alert>
        <div className="mt-4">
          <Button variant="ghost" className="w-full" onClick={() => navigate('/')}>
            Back
          </Button>
        </div>
      </Screen>
    )
  }

  if (issued !== null) {
    return (
      <Screen>
        <BackLink to="/sell" label="Sell" />
        <PageHeader title="Cashlink ready" subtitle="Let the customer scan the QR, or share the link." />
        <IssuedCode
          issued={issued}
          decimals={decimals}
          owner={!actor || actor.kind === 'owner'}
          onAgain={() => {
            setIssued(null)
            setAmount('')
            setMemo('')
          }}
          onDone={() => navigate('/')}
        />
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to="/sell" label="Sell" />
      <PageHeader title="Create a Cashlink" subtitle="For a customer without the app yet." />

      {error && <Alert>{error}</Alert>}

      <Panel className="p-4">
        <Input
          label={`Amount (${merchant.issuanceCurrency})`}
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
        <div className="mt-4">
          <Input
            label="Note (optional)"
            placeholder="What it is for"
            value={memo}
            // The portal's own cap (@Size(max = 280)), and a till's cashback row must fit one
            // relay event (note.ts, review sh6).
            maxLength={NOTE_MAX_CHARS}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>
      </Panel>

      <p className="mt-3 text-sm text-mono-500">
        The customer gets a link and QR to scan. It works for{' '}
        {expiryDays} {expiryDays === 1 ? 'day' : 'days'}, once.
      </p>

      <Button
        size="lg"
        className="mt-4 w-full"
        disabled={minor === null || busy}
        onClick={() => void submit()}
      >
        {busy ? 'Creating the Cashlink…' : 'Create Cashlink'}
      </Button>
    </Screen>
  )
}

/**
 * The Cashlink just created: amount, then the QR and Share link first (claim links phase 2, spec
 * 4.1; typed codes retired, wallet#268). The screen follows the claim live until it settles.
 */
function IssuedCode({
  issued,
  decimals,
  owner,
  onAgain,
  onDone,
}: {
  issued: IssuedCashback
  decimals: number
  /**
   * The stall's own device. A till (#160 phase 5) gets the link and QR, but the portal's status
   * and revoke are owner-only and need a session a till never has, so it neither polls nor offers
   * Cancel: the owner cancels from the record the till files in their history.
   */
  owner: boolean
  onAgain: () => void
  onDone: () => void
}) {
  const [cancelled, setCancelled] = useState(false)
  const live = useLiveCashbackStatus(issued.cashbackId || undefined, owner && !cancelled)
  const status = cancelled ? 'Revoked' : live?.status
  const link = issued.claim
    ? formatCashbackLink(window.location.origin, issued.claim.ref, issued.claim.key)
    : null

  return (
    <>
      <Panel>
        <div className="flex flex-col items-center py-6 text-center">
          <div className="mb-3 rounded-full bg-green-600/10 p-3">
            <Check className="h-7 w-7 text-green-600" />
          </div>
          <p className="text-lg text-mono-900 dark:text-mono-50">
            {formatFace(issued.amountMinor, { unit: issued.unit, decimals })}
          </p>
          {issued.expiresAt && (
            <p className="mt-1 text-sm text-mono-500">
              Must be claimed by {formatDate(issued.expiresAt)}.
            </p>
          )}
        </div>
      </Panel>

      <div className="mt-4 space-y-2">
        <ClaimState status={status} link={link} expiresAt={issued.expiresAt} initiallyShown />
        {owner && issued.cashbackId && isOpen(status) ? (
          <CancelCashback cashbackId={issued.cashbackId} onCancelled={() => setCancelled(true)} />
        ) : null}
        <Button size="lg" className="w-full" onClick={onAgain}>
          Create another
        </Button>
        <Button variant="ghost" className="w-full" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  )
}

/** Unclaimed, or not known yet: the link is still live. */
function isOpen(status: string | undefined): boolean {
  return status === undefined || status === 'Unclaimed'
}

/** What replaces the QR once the claim has closed (spec 4.1, "Claimed just now"). */
const CLOSED_LINE: Record<string, string> = {
  Claimed: 'Claimed just now',
  Revoked: 'Cancelled. The Cashlink no longer works.',
  Expired: 'Expired. The Cashlink no longer works.',
  ManualAttention: 'Closed. Ask support about this one.',
}

/** The link and QR while the claim is open, the closed line once it is not. */
function ClaimState({
  status,
  link,
  expiresAt,
  initiallyShown = false,
}: {
  status: string | undefined
  link: string | null
  expiresAt: string
  initiallyShown?: boolean
}) {
  if (!isOpen(status)) {
    return (
      <p
        role="status"
        className="rounded-xl bg-mono-100 p-3 text-center text-sm font-medium text-mono-900 dark:bg-mono-800 dark:text-mono-50"
      >
        {CLOSED_LINE[status ?? ''] ?? CLOSED_LINE.ManualAttention}
      </p>
    )
  }
  return link ? <ClaimLinkPanel link={link} expiresAt={expiresAt} initiallyShown={initiallyShown} /> : null
}
