import { useState } from 'react'
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
import { identityLabel, useIdentity } from '../lib/identity'
import { currencyDecimals, formatDate, formatFace, parseAmountToMinor } from '../lib/format'
import { ValidityPicker } from '../components/ValidityPicker'
import { useCashbackAvailable } from '../lib/cashback'
import type { MerchantProfile } from '../lib/merchant'

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
 * For the customer who does not, `/sell/cashback` issues a bearer code instead.
 * It is the deliberate opposite trade: no recipient, no delivery, and whoever
 * repeats the code back gets the money.
 */

const STAGE_LABEL: Record<IssueStage, string> = {
  issuing: 'Issuing the voucher…',
  // Named for what is actually happening: the coupon exists but has no Cashu
  // token yet, because its Lightning backing is still settling.
  minting: 'Waiting for the voucher to be backed…',
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

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Sell" subtitle={customer ? undefined : "Scan the customer's code"} />

      {customer === null ? (
        <>
          <ScanRecipient onFound={setCustomer} selfPubkey={pubkey} />
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
        Give cashback instead
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
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [stage, setStage] = useState<IssueStage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<number | null>(null)
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
    try {
      const { voucher } = await issueAndDeliver(
        {
          faceValueMinor: minor,
          currency: merchant.issuanceCurrency,
          expiryDays: validity,
          memo: memo.trim() || undefined,
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
      setSentExpiry(formatDate(voucher.expires_at))
      setSent(minor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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

        {error && <Alert>{error}</Alert>}
      </div>
    </>
  )
}
