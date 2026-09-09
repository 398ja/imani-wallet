import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Copy } from 'lucide-react'

import { Button, Screen, BackLink, PageHeader, Alert, Panel, Input } from '../components/ui'
import { generateCashback, type IssuedCashback } from '../lib/cashback'
import { gatewayConfig, DEFAULT_CASHBACK_EXPIRY_DAYS } from '../lib/config'
import { currencyDecimals, formatDate, formatFace, parseAmountToMinor } from '../lib/format'
import type { MerchantProfile } from '../lib/merchant'
import { buildCashbackTransaction } from '../lib/transactions'
import { getWallet, notifyWalletChanged } from '../lib/wallet'

/**
 * Issue cashback: a coupon for someone who has not installed the app.
 *
 * The counterpart to Sell, and the difference is who has to be present. Sell
 * needs the customer standing there with a wallet to scan; this needs nothing
 * but a pen. The merchant types an amount, reads six characters out loud, and
 * the customer redeems them days later on a phone that does not exist yet.
 *
 * No recipient step, and therefore no scan step — the whole screen is one
 * amount field. Whoever repeats the code back gets the money, which is the
 * trade being made for reaching someone who cannot yet be addressed.
 */
export function CashbackIssuePage({ merchant }: { merchant: MerchantProfile }) {
  const navigate = useNavigate()
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedCashback | null>(null)
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
    try {
      const cashback = await generateCashback({
        amountMinor: minor,
        unit: merchant.issuanceCurrency,
        memo: memo.trim() || undefined,
        expiryDays,
      })
      await record(cashback, decimals, memo.trim())
      setIssued(cashback)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (issued !== null) {
    return (
      <Screen>
        <BackLink to="/sell" label="Sell" />
        <PageHeader title="Cashback ready" subtitle="Give this code to the customer." />
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
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>
      </Panel>

      <p className="mt-3 text-sm text-mono-500">
        The customer gets a short code to type into their wallet. It works for{' '}
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
 * The merchant's own record of the code, written for the same reason every
 * other merchant row is: nothing else on this device holds it.
 *
 * Without it a cashback leaves no trace at all — the code goes onto a paper
 * receipt and the merchant has no way to find it again, let alone ask whether
 * it was ever redeemed. The row is what the transaction detail screen looks the
 * status up BY.
 *
 * Non-fatal but never silent, matching `issueAndDeliver`: the code has already
 * been minted and is about to go on screen, so throwing here would report a
 * live cashback as a failed one. A missing history entry beats a phantom
 * failure.
 */
async function record(issued: IssuedCashback, decimals: number, memo: string): Promise<void> {
  try {
    const expiresAt = Date.parse(issued.expiresAt)
    await getWallet().addTransaction(
      buildCashbackTransaction({
        cashbackId: issued.cashbackId,
        claimCode: issued.claimCode,
        amount: issued.amountMinor,
        unit: issued.unit,
        decimals,
        memo: memo || undefined,
        // Epoch SECONDS, as the builder documents and as every other expiry on
        // the wire is carried.
        expiresAt: Number.isNaN(expiresAt) ? undefined : Math.floor(expiresAt / 1000),
        at: Date.now(),
      }),
    )
    // The relay copy rides along with the write — `openWallet` wraps
    // `addTransaction` — but a write made by this tab is not echoed back to it,
    // so the history screen behind this one needs telling. Same as issue.ts.
    notifyWalletChanged()
  } catch (error) {
    console.error('[cashback] issuance not recorded in history', error)
  }
}

/**
 * The code, and nothing competing with it.
 *
 * Sized and spaced to be read across a counter and copied down by hand, which
 * is the only thing this screen is for: wide tracking so the six characters
 * separate, monospace so `0` and `O` cannot trade places, and negative-tracked
 * display type everywhere else per the house scale.
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.claimCode)
      setCopied(true)
      // Long enough to register as confirmation, short enough that the button
      // is back to its normal label before anyone reaches for it again.
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard permission is not something the merchant can act on, and the
      // code is already on screen to be read aloud — which is the point of it.
    }
  }

  return (
    <>
      <Panel>
        <div className="flex flex-col items-center py-6 text-center">
          <div className="mb-3 rounded-full bg-green-600/10 p-3">
            <Check className="h-7 w-7 text-green-600" />
          </div>
          <p className="select-all font-mono text-3xl font-semibold tracking-[0.2em] text-mono-900 dark:text-mono-50">
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
