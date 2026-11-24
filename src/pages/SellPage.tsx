import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'

import {
  Button,
  Screen,
  BackLink,
  PageHeader,
  Alert,
  Panel,
  Input,
  IdentityInline,
} from '../components/ui'
import { ScanRecipient } from '../components/ScanRecipient'
import type { Actor } from '../lib/actor'
import type { TerminalSession } from '../lib/terminalSession'
import { issueAndDeliver, type IssueStage } from '../lib/issue'
import { TERMINAL_SALE_UNSUPPORTED, mayWarrantSale } from '../lib/warrantSigner'
import { identityLabel, useIdentity } from '../lib/identity'
import { currencyDecimals, formatDate, formatFace, parseAmountToMinor } from '../lib/format'
import { ValidityPicker } from '../components/ValidityPicker'
import { useCashbackAvailable } from '../lib/cashback'
import type { MerchantProfile } from '../lib/merchant'
import { NOTE_MAX_CHARS, clampNote } from '../lib/note'
import { userMessage } from '../lib/userMessage'
import { SalesLimitError } from '../lib/entitlement'
import { UPGRADE_PATH, salesAllowance } from '../lib/salesAllowance'
import { canReadReceiptsNow } from '../lib/terminalSession'
import { isReceiptQr } from '../lib/receipts/verify'

/**
 * Sell: issue a coupon to a customer standing in front of you.
 *
 * Three screens — scan, amount, progress — because the flow is deliberately the
 * simplified one: no cart, no line items, no payment method. The merchant scans
 * the address the customer's own `/receive` screen is already showing — their
 * NIP-05 handle — types what they owe, and sends.
 *
 * The coupon is addressed to a pubkey and delivered as a DM, which is what makes
 * it show up in the customer's wallet without them doing anything — and what
 * requires them to have a wallet at all.
 *
 * For the customer who does not, `/sell/cashback` creates a Cashlink (a bearer link and QR) instead.
 * It is the deliberate opposite trade: no recipient, no delivery, and whoever
 * repeats the code back gets the money.
 */

const STAGE_LABEL: Record<IssueStage, string> = {
  issuing: 'Issuing the voucher…',
  // The coupon exists but has no Cashu token yet: this is the mint step, which
  // for a quote-backed coupon includes waiting for its Lightning backing to settle.
  minting: 'Minting the voucher…',
  delivering: 'Delivering to the customer…',
}

export function SellPage({
  pubkey,
  merchant,
  actor,
  session,
}: {
  pubkey: string
  merchant: MerchantProfile
  /**
   * The terminal selling, if this device is one.
   *
   * Absent on the stall's own device. Passed through rather than assumed,
   * because this screen used to BUILD an owner actor unconditionally — so a
   * terminal that reached /sell issued with the stall's full authority, and a
   * revoked one could still mint. The comment beside that line already
   * promised "a terminal reaches the same call with a credential-derived
   * actor"; nothing supplied one.
   */
  actor?: Actor
  session?: TerminalSession | null
}) {
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<string | null>(null)
  const isOwner = (actor?.kind ?? 'owner') === 'owner'
  // Spec 049: the camera is already pointed at the customer's phone here, so a receipt scanned on
  // Sell is checked rather than sold to. The till's own rule (`receipt:read`, live session); the
  // owner always may.
  const mayCheckReceipts = actor ? canReadReceiptsNow(actor, session ?? null) : true
  const [scanError, setScanError] = useState<string | null>(null)
  const onScanned = (text: string): boolean => {
    if (!isReceiptQr(text)) {
      setScanError(null)
      return false
    }
    if (!mayCheckReceipts) {
      setScanError('That is a payment receipt. This till cannot check receipts: ask the stall owner.')
      return true
    }
    // Router state, never the URL: it carries a payer signature and the key to its evidence.
    navigate('/receipt/check', { state: { qr: text.trim() } })
    return true
  }
  // Review of gc#317: a stall whose Free plan is used up does not start a sale. The owner is taken
  // to the upgrade screen; a till is told to ask the owner (only the owner can buy a plan, ADR 0007).
  // `null` while asking; an unreadable answer lets the sale go ahead, since the mint still refuses.
  const [allowanceReached, setAllowanceReached] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void salesAllowance(merchant.issuanceCurrency).then((a) => {
      if (!live) return
      const reached = a.kind === 'limited' && a.reached
      setAllowanceReached(reached)
      if (reached && isOwner) navigate(UPGRADE_PATH, { replace: true })
    })
    return () => {
      live = false
    }
  }, [merchant.issuanceCurrency, isOwner, navigate])

  /*
    A terminal cannot sign a warrant the customer's wallet accepts, so a sale
    here would take the customer's money for a coupon their wallet refuses
    (#159). Stopped on arrival, before a customer is scanned or an amount is
    typed, so staff learn it before taking payment rather than after.
    `issueAndDeliver` refuses the same request made around this screen.
  */
  if (actor && !mayWarrantSale(actor, session ?? null)) {
    return (
      <Screen>
        <BackLink to="/" label="Back" />
        <PageHeader title="Sell" />
        <Alert>{TERMINAL_SALE_UNSUPPORTED}</Alert>
        <div className="mt-4">
          <Button variant="ghost" className="w-full" onClick={() => navigate('/')}>
            Back
          </Button>
        </div>
      </Screen>
    )
  }

  if (allowanceReached && !isOwner) {
    return (
      <Screen>
        <BackLink to="/" label="Back" />
        <PageHeader title="Sell" />
        <Alert>
          <span data-testid="sales-limit-reached-till">
            This stall has used its Free plan’s issuance allowance, so this till cannot sell vouchers.
            Ask the stall owner to upgrade the plan. Redeeming coupons still works.
          </span>
        </Alert>
        <div className="mt-4">
          <Button variant="ghost" className="w-full" onClick={() => navigate('/')}>
            Back
          </Button>
        </div>
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader
        title="Sell"
        subtitle={
          customer
            ? undefined
            : mayCheckReceipts
              ? "Scan the customer's code, or a receipt to check it"
              : "Scan the customer's code"
        }
      />

      {customer === null ? (
        <>
          {scanError ? (
            <div className="mb-3">
              <Alert>{scanError}</Alert>
            </div>
          ) : null}
          <ScanRecipient onFound={setCustomer} onText={onScanned} selfPubkey={pubkey} />
          <CashbackLink />
        </>
      ) : (
        <IssueForm
          customer={customer}
          merchant={merchant}
          issuerPubkey={pubkey}
          actor={actor}
          session={session}
          onRescan={() => setCustomer(null)}
          onDone={() => navigate('/')}
        />
      )}
    </Screen>
  )
}

/**
 * The way out for a customer with nothing to scan.
 *
 * Offered on the scan step because that is exactly where the merchant discovers
 * the problem — the customer has no app, so there is no code to point a camera
 * at. Hidden entirely where the deployment has cashback switched off, rather
 * than offered and then apologised for.
 */
function CashbackLink() {
  if (!useCashbackAvailable()) return null

  return (
    <div className="mt-6 text-center">
      <p className="text-sm text-mono-500">No app to scan?</p>
      <Link
        to="/sell/cashback"
        className="pressable mt-1 inline-block text-sm font-medium text-mono-900 underline-offset-4 hover:underline dark:text-mono-50"
      >
        Create a Cashlink instead
      </Link>
    </div>
  )
}

function IssueForm({
  customer,
  merchant,
  issuerPubkey,
  actor,
  session,
  onRescan,
  onDone,
}: {
  customer: string
  merchant: MerchantProfile
  issuerPubkey: string
  actor?: Actor
  session?: TerminalSession | null
  onRescan: () => void
  onDone: () => void
}) {
  const navigate = useNavigate()
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [stage, setStage] = useState<IssueStage | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The plan's allowance refused the sale: shown with an invitation to upgrade, not as a fault.
  const [limitReached, setLimitReached] = useState(false)
  const [sent, setSent] = useState<number | null>(null)
  // How many coupons the sale became. Almost always 1; more when the gateway
  // split it. Shown on the confirmation so the merchant and the customer are
  // counting the same thing.
  const [sentParts, setSentParts] = useState(1)
  /**
   * How far short the delivery fell, in minor units. Zero on every normal sale.
   *
   * The portal decides how a large sale is split, so the parts adding up to the
   * whole is its promise rather than this screen's. If it is ever broken, the
   * merchant must see it while the customer is still there.
   */
  const [shortfall, setShortfall] = useState(0)
  // What this coupon actually got, once the gateway has settled it — which is
  // not always what was asked for, hence `waitForExpiry` in lib/issue.ts.
  const [sentExpiry, setSentExpiry] = useState<string>('')
  // The stall's default, for this sale only. Never sticky between sales: an
  // expiry that quietly persisted would mint a 7-day coupon an hour later with
  // nothing on screen to explain it. Null while a custom term is half-typed.
  const [validity, setValidity] = useState<number | null>(merchant.voucherValidityDays)
  const customerIdentity = useIdentity(customer)

  // ISO decimals, which is what the sats backing needs — see currencyDecimals.
  // The gateway labels every coupon 2-decimal regardless; that mismatch is its
  // bug, and matching it here costs a hundredfold over-backing and a 413.
  const decimals = currencyDecimals(merchant.issuanceCurrency)
  const minor = parseAmountToMinor(amount, decimals)
  const busy = stage !== null

  const submit = async () => {
    if (minor === null || validity === null) return
    setError(null)
    setLimitReached(false)
    try {
      const { vouchers, deliveredValue } = await issueAndDeliver(
        {
          faceValueMinor: minor,
          currency: merchant.issuanceCurrency,
          expiryDays: validity,
          memo: clampNote(memo.trim() || undefined),
          recipientPubkey: customer,
          // The ACTOR, not a key. On the owner's own device the stall IS the
          // session pubkey — a positive claim rather than the fallback
          // terminals ticket 02 removes. A terminal passes its
          // credential-derived actor and never its own disposable key, which
          // is what makes the role gating real: `issueAndDeliver` asks
          // `canIssueNow` of whatever arrives here.
          actor: actor ?? { kind: 'owner', stallPubkey: issuerPubkey },
          // Carried so the enforcement point can see a lapsed or reduced
          // session. Undefined for an owner, who never has one.
          session,
        },
        setStage,
      )
      // The LAST part's expiry. Every part of a split sale is issued with the
      // same term, so they agree; the last is simply the one whose wait
      // finished most recently.
      setSentExpiry(formatDate(vouchers[vouchers.length - 1]?.expires_at))
      // How many coupons the customer actually received. A big sale is split
      // into several (see lib/issue.ts), and the customer sees that many
      // separate coupons in their wallet — so the merchant must be told, or
      // the two of them count the sale differently at the stall.
      setSentParts(vouchers.length)
      // What the customer ACTUALLY received, not what was typed. The two agree
      // on every ordinary sale; when they do not, the merchant is standing in
      // front of the customer and needs the real figure, not the intended one.
      setSent(deliveredValue)
      setShortfall(deliveredValue !== minor ? minor - deliveredValue : 0)
    } catch (e) {
      // Refused at the mint (another device sold the last of the allowance, or the pre-check was
      // unreadable): the owner goes straight to the upgrade screen, a till keeps the message.
      if (e instanceof SalesLimitError && (actor?.kind ?? 'owner') === 'owner') {
        navigate(UPGRADE_PATH)
        return
      }
      setLimitReached(e instanceof SalesLimitError)
      setError(userMessage(e))
    } finally {
      setStage(null)
    }
  }

  // Confirmation only after the DM has actually gone out — the whole reason the
  // merchant was held through the wait rather than told "sent" immediately.
  if (sent !== null) {
    return (
      <>
        <Panel>
          <div className="flex flex-col items-center py-4 text-center">
            <div className="mb-3 rounded-full bg-green-600/10 p-3">
              <Check className="h-7 w-7 text-green-600" />
            </div>
            <p className="text-amount text-mono-900 dark:text-mono-50">
              {formatFace(sent, { unit: merchant.issuanceCurrency, decimals })}
            </p>
            <p className="mt-1 text-sm text-mono-500">
              Sent to {identityLabel(customer, customerIdentity)}. It is in their wallet now.
            </p>
            {/* A split sale arrives as several separate coupons, so the customer
                will not find one coupon for the amount on this screen. Saying so
                here is what stops them reporting a shortfall at the stall. */}
            {sentParts > 1 && (
              <p className="mt-1 text-sm text-mono-500">
                Sent as {sentParts} separate coupons, which together are worth the
                amount above.
              </p>
            )}
            {/* Never expected, and loud when it happens: the amount above is
                what the customer HOLDS, so a gap means the rest is still owed. */}
            {shortfall > 0 && (
              <p className="mt-2 text-sm font-medium text-red-600">
                That is{' '}
                {formatFace(shortfall, { unit: merchant.issuanceCurrency, decimals })} less
                than you asked for. The rest was not delivered and is still owed.
              </p>
            )}
            {/* The expiry the coupon was actually granted, not the one asked
                for. Blank when the gateway never returned one, which is a
                degraded coupon rather than a failed sale — see lib/issue.ts. */}
            {sentExpiry && (
              <p className="mt-1 text-sm text-mono-500">Valid until {sentExpiry}.</p>
            )}
          </div>
        </Panel>

        <div className="mt-4 space-y-2">
          <Button
            size="lg"
            className="w-full"
            onClick={() => {
              setSent(null)
              setSentParts(1)
              setShortfall(0)
              setAmount('')
              setMemo('')
              setValidity(merchant.voucherValidityDays)
              onRescan()
            }}
          >
            Sell to someone else
          </Button>
          <Button variant="ghost" className="w-full" onClick={onDone}>
            Done
          </Button>
        </div>
      </>
    )
  }

  return (
    <>
      <Panel className="p-4">
        <div className="flex items-center justify-between">
          <IdentityInline pubkey={customer} label="Customer" size="md" />
          <Button variant="ghost" size="sm" onClick={onRescan} disabled={busy}>
            Change
          </Button>
        </div>
      </Panel>

      <div className="mt-4 space-y-4">
        <Input
          label={`Amount (${merchant.issuanceCurrency})`}
          // `decimal` gives a keypad with a separator; a zero-decimal currency
          // has nothing to type after the point, so it gets the plain numeric one.
          inputMode={decimals > 0 ? 'decimal' : 'numeric'}
          placeholder={decimals > 0 ? '0.00' : '0'}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy}
          autoFocus
        />

        <Input
          label="Note (optional)"
          placeholder="£5 welcome voucher"
          value={memo}
          // Capped (note.ts): a till's sale row must fit one relay event (review sh6).
          maxLength={NOTE_MAX_CHARS}
          onChange={(e) => setMemo(e.target.value)}
          disabled={busy}
        />

        <ValidityPicker
          label="Voucher valid for"
          value={validity}
          defaultDays={merchant.voucherValidityDays}
          onChange={setValidity}
          disabled={busy}
        />

        <Button
          size="lg"
          className="w-full"
          disabled={busy || minor === null || validity === null}
          onClick={submit}
        >
          {stage ? STAGE_LABEL[stage] : 'Send voucher'}
        </Button>

        {busy && (
          <p className="text-center text-xs text-mono-400" role="status" aria-live="polite">
            This takes a few seconds. Do not close this screen.
          </p>
        )}

        {error && (
          <Alert>
            <span data-testid={limitReached ? 'sales-limit-reached' : undefined}>{error}</span>
            {/* Only the owner can buy a plan; a till is told to ask them (ADR 0007). */}
            {limitReached && (actor?.kind ?? 'owner') === 'owner' && (
              <>
                {' '}
                <Link to="/settings/subscription" className="font-medium underline" data-testid="sales-limit-upgrade">
                  Upgrade my plan
                </Link>
              </>
            )}
            {limitReached && actor && actor.kind !== 'owner' && (
              <> Ask the stall owner to upgrade the plan.</>
            )}
          </Alert>
        )}
      </div>
    </>
  )
}
