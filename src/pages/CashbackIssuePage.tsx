import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Copy } from 'lucide-react'

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

/**
 * Issue cashback: a coupon for someone who has not installed the app.
 *
 * The counterpart to Sell, and the difference is who has to be present. Sell
 * needs the customer standing there with a wallet to scan; this needs nothing
 * but a pen. The merchant types an amount, reads ten characters out loud, and
 * the customer redeems them days later on a phone that does not exist yet.
 *
 * No recipient step, and therefore no scan step — the whole screen is one
 * amount field. Whoever repeats the code back gets the money, which is the
 * trade being made for reaching someone who cannot yet be addressed.
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
      setError(e instanceof Error ? e.message : String(e))
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
        <PageHeader title="Cashback" />
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
        <PageHeader title="Cashback ready" subtitle="Give the customer this code, or let them scan the QR." />
        <IssuedCode
          issued={issued}
          decimals={decimals}
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
      <PageHeader title="Cashback" subtitle="For a customer without the app yet." />

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
        The customer gets a short code and a link: they scan, or type into their wallet. It works for{' '}
        {expiryDays} {expiryDays === 1 ? 'day' : 'days'}, once.
      </p>

      <Button
        size="lg"
        className="mt-4 w-full"
        disabled={minor === null || busy}
        onClick={() => void submit()}
      >
        {busy ? 'Creating the code…' : 'Create cashback code'}
      </Button>
    </Screen>
  )
}

/**
 * The code, then the link and QR beside it (claim links phase 2, spec 4.1).
 *
 * The code comes first and is unchanged (Q2): sized and spaced to be read across a counter and
 * copied down by hand, monospace so `0` and `O` cannot trade places. Below it, Show QR and Share
 * link carry the same claim as a link, and the screen follows the claim live until it settles.
 */
function IssuedCode({
  issued,
  decimals,
  onAgain,
  onDone,
}: {
  issued: IssuedCashback
  decimals: number
  onAgain: () => void
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const live = useLiveCashbackStatus(issued.cashbackId || undefined, !cancelled)
  const status = cancelled ? 'Revoked' : live?.status
  const link = issued.claim
    ? formatCashbackLink(window.location.origin, issued.claim.ref, issued.claim.key)
    : null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.claimCode)
      setCopied(true)
      // Long enough to register as confirmation, short enough that the button
      // is back to its normal label before anyone reaches for it again.
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard permission is not something the merchant can act on, and the
      // code is already on screen to be read aloud, which is the point of it.
    }
  }

  return (
    <>
      <Panel>
        <div className="flex flex-col items-center py-6 text-center">
          <div className="mb-3 rounded-full bg-green-600/10 p-3">
            <Check className="h-7 w-7 text-green-600" />
          </div>
          <p className="select-all break-all font-mono text-2xl font-semibold tracking-[0.15em] text-mono-900 dark:text-mono-50">
            {issued.claimCode}
          </p>
          <p className="mt-3 text-lg text-mono-900 dark:text-mono-50">
            {formatFace(issued.amountMinor, { unit: issued.unit, decimals })}
          </p>
          {issued.expiresAt && (
            <p className="mt-1 text-sm text-mono-500">
              Must be redeemed by {formatDate(issued.expiresAt)}.
            </p>
          )}
        </div>
      </Panel>

      <div className="mt-4 space-y-2">
        <ClaimState status={status} link={link} expiresAt={issued.expiresAt} />
        <Button variant="secondary" size="lg" className="w-full" onClick={() => void copy()}>
          {copied ? (
            <>
              <Check className="mr-2 h-4 w-4" /> Copied
            </>
          ) : (
            <>
              <Copy className="mr-2 h-4 w-4" /> Copy code
            </>
          )}
        </Button>
        {issued.cashbackId && isOpen(status) ? (
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
  Revoked: 'Cancelled. The link and the code no longer work.',
  Expired: 'Expired. The link and the code no longer work.',
  ManualAttention: 'Closed. Ask support about this one.',
}

/** The link and QR while the claim is open, the closed line once it is not. */
function ClaimState({
  status,
  link,
  expiresAt,
}: {
  status: string | undefined
  link: string | null
  expiresAt: string
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
  return link ? <ClaimLinkPanel link={link} expiresAt={expiresAt} /> : null
}
