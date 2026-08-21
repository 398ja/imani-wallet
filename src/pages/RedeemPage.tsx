import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Copy, Share2 } from 'lucide-react'
import QRCode from 'qrcode'

import { Button, Screen, BackLink, PageHeader, Alert, Panel, Input } from '../components/ui'
import { currencyDecimals, formatFace, parseAmountToMinor, formatDate } from '../lib/format'
import type { MerchantProfile } from '../lib/merchant'
import {
  createRequest,
  expireRequests,
  loadRequests,
  matchPayment,
  groupArrivals,
  partialFor,
  saveRequests,
  type VoucherPaymentRequest,
} from '../lib/vreq'
import { listTransactions } from '../lib/wallet'
import { onWalletChanged } from '../lib/wallet'
import { toTransaction } from '../lib/transactions'

/**
 * Redeem: take a customer's coupons as payment.
 *
 * The merchant asks for an amount, the app shows a NUT-18V request as a QR, and
 * the customer pays it from their own wallet's `/scan` → `/pay` path. No
 * customer-side work at all: that half already existed for paying merchants.
 *
 * HOW FULFILMENT IS SEEN: paying goes through `POST /api/v1/atomic-send`, whose
 * saga DMs the token to the request's issuer — this merchant. The merchant's own
 * `startDmPoll` picks it up like any other incoming coupon, so watching
 * `onWalletChanged` is the whole detection mechanism. possa-merchant polls
 * `/merchant/payment-requests/check` every 30s, but that endpoint does not exist
 * on this stack; see lib/vreq.ts.
 */
export function RedeemPage({ pubkey, merchant }: { pubkey: string; merchant: MerchantProfile }) {
  const navigate = useNavigate()
  const [request, setRequest] = useState<VoucherPaymentRequest | null>(null)

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Redeem" subtitle={request ? undefined : 'What does the customer owe?'} />

      {request === null ? (
        <RequestForm merchant={merchant} issuerPubkey={pubkey} onCreated={setRequest} />
      ) : (
        <RequestDisplay
          pubkey={pubkey}
          request={request}
          onChange={setRequest}
          onNew={() => setRequest(null)}
          onDone={() => navigate('/')}
        />
      )}
    </Screen>
  )
}

function RequestForm({
  merchant,
  issuerPubkey,
  onCreated,
}: {
  merchant: MerchantProfile
  issuerPubkey: string
  onCreated: (request: VoucherPaymentRequest) => void
}) {
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [error, setError] = useState<string | null>(null)

  // ISO decimals, which is what the sats backing needs — see currencyDecimals.
  // The gateway labels every coupon 2-decimal regardless; that mismatch is its
  // bug, and matching it here costs a hundredfold over-backing and a 413.
  const decimals = currencyDecimals(merchant.issuanceCurrency)
  const minor = parseAmountToMinor(amount, decimals)

  const submit = () => {
    if (minor === null) return
    setError(null)
    try {
      const created = createRequest({
        amount: minor,
        unit: merchant.issuanceCurrency,
        issuerPubkey,
        description: memo,
      })
      // Persisted before it is shown: a request the merchant is looking at but
      // that was never stored cannot be matched against an incoming payment
      // after a reload.
      const stored = expireRequests(loadRequests(issuerPubkey))
      saveRequests(issuerPubkey, [created, ...stored].slice(0, 50))
      onCreated(created)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-4">
      <Input
        label={`Amount (${merchant.issuanceCurrency})`}
        inputMode={decimals > 0 ? 'decimal' : 'numeric'}
        placeholder={decimals > 0 ? '0.00' : '0'}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        autoFocus
      />
      <Input
        label="Note (optional)"
        placeholder="Flat white and a pastry"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
      />
      <Button size="lg" className="w-full" disabled={minor === null} onClick={submit}>
        Show payment code
      </Button>
      {error && <Alert>{error}</Alert>}
    </div>
  )
}

/*
 * Two shades per colour, not one. These are xs text on a tinted fill, so they
 * need 4.5:1 in BOTH themes, and no single step of the ramp gives it: green 600
 * is 3.3:1 on white, and red 500 is 3.8:1. The darker step carries the light
 * theme and the lighter one carries the dark, which is the same pairing the
 * mono row below already uses and the same red as every other error in the app.
 */
const STATUS_STYLE: Record<VoucherPaymentRequest['status'], string> = {
  pending: 'bg-mono-100 text-mono-600 dark:bg-mono-900 dark:text-mono-300',
  fulfilled: 'bg-green-600/10 text-green-700 dark:text-green-500',
  expired: 'bg-red-600/10 text-red-600 dark:text-red-400',
}

const STATUS_LABEL: Record<VoucherPaymentRequest['status'], string> = {
  pending: 'Waiting for payment',
  fulfilled: 'Paid',
  expired: 'Expired',
}

function RequestDisplay({
  pubkey,
  request,
  onChange,
  onNew,
  onDone,
}: {
  pubkey: string
  request: VoucherPaymentRequest
  onChange: (request: VoucherPaymentRequest) => void
  onNew: () => void
  onDone: () => void
}) {
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** Minor units received against this request so far, when it is not yet paid. */
  const [received, setReceived] = useState(0)
  // From the request rather than the stall: a request already carries the unit
  // it was created with, and re-reading the merchant record here would relabel
  // an open request if the currency were changed in settings mid-sale.
  const decimals = currencyDecimals(request.unit)

  useEffect(() => {
    // The QR encodes the `cashu:` URI rather than the bare `vreqA…`, so a
    // general-purpose scanner can route it to a wallet instead of showing text.
    QRCode.toDataURL(request.clickableUri, { width: 320, margin: 1 }).then(setQr, () => setQr(null))
  }, [request.clickableUri])

  /** Persist a status change to the stored list as well as to this screen. */
  const settle = useCallback(
    (next: VoucherPaymentRequest) => {
      const stored = loadRequests(pubkey)
      saveRequests(
        pubkey,
        stored.map((r) => (r.paymentId === next.paymentId ? next : r)),
      )
      onChange(next)
    },
    [pubkey, onChange],
  )

  useEffect(() => {
    if (request.status !== 'pending') return

    let live = true

    // Re-read the wallet and look for a transaction that settles this request.
    // Runs once on mount as well as on every change, because the payment can
    // land between the request being shown and this effect subscribing.
    const check = async () => {
      try {
        // Grouped, not raw: a payment drawn across several coupons arrives as
        // one row per coupon, and each on its own is an underpayment that
        // `matchPayment` rejects. See `groupArrivals`.
        const arrivals = groupArrivals((await listTransactions()).map(toTransaction))
        if (!live) return
        for (const arrival of arrivals) {
          const settled = matchPayment([request], arrival)
          if (settled) {
            settle(settled)
            return
          }
        }
        // Nothing settles it yet. If part of it has landed, say so — the
        // alternative is a screen that looks identical to no payment at all
        // while the merchant is holding half the money.
        setReceived(partialFor(request, arrivals))
      } catch {
        // A wallet read that fails leaves the request pending, which is the
        // honest state — never mark it paid on an error path.
      }
    }

    void check()
    const unsubscribe = onWalletChanged(() => void check())

    // Expiry is a clock event, not a wallet event, so it needs its own timer.
    const timer = setInterval(() => {
      if (request.expiresAt * 1000 <= Date.now()) {
        settle({ ...request, status: 'expired' })
      }
    }, 5000)

    return () => {
      live = false
      unsubscribe()
      clearInterval(timer)
    }
  }, [request, settle])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(request.requestString)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard denied. The request string is on screen to be typed.
    }
  }

  const canShare = typeof navigator.share === 'function'

  const share = async () => {
    try {
      await navigator.share({ text: request.clickableUri })
    } catch {
      // Cancelled or unsupported — the button is only rendered when the API
      // exists, so this is almost always the user dismissing the sheet.
    }
  }

  return (
    <>
      <Panel>
        <div className="flex flex-col items-center py-2 text-center">
          <span
            className={`mb-3 rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLE[request.status]}`}
            role="status"
            aria-live="polite"
          >
            {STATUS_LABEL[request.status]}
          </span>

          <p className="text-amount text-mono-900 dark:text-mono-50">
            {formatFace(request.amount, { unit: request.unit, decimals })}
          </p>

          {request.description && (
            <p className="mt-1 text-sm text-mono-500">{request.description}</p>
          )}

          {request.status === 'pending' && received > 0 && received < request.amount && (
            <p className="mt-2 text-sm text-amber-600" role="status" aria-live="polite">
              {formatFace(received, { unit: request.unit, decimals })} of{' '}
              {formatFace(request.amount, { unit: request.unit, decimals })} received
            </p>
          )}

          {/* Only while pending: a QR for a paid or dead request is a trap — it
              still scans, and the customer would be paying a second time. */}
          {request.status === 'pending' && qr && (
            <img
              src={qr}
              alt="Payment request QR code"
              className="mt-4 w-full max-w-[280px] rounded-2xl bg-white p-3"
            />
          )}

          {request.status === 'fulfilled' && (
            <div className="mt-4 flex flex-col items-center">
              <div className="rounded-full bg-green-600/10 p-3">
                <Check className="h-7 w-7 text-green-600" />
              </div>
              {request.receivedAmount !== undefined &&
                request.receivedAmount > request.amount && (
                  <p className="mt-2 text-sm text-mono-500">
                    Received {formatFace(request.receivedAmount, { unit: request.unit, decimals })}
                  </p>
                )}
            </div>
          )}

          {request.status === 'pending' && (
            <p className="mt-3 text-xs text-mono-400">
              Expires {formatDate(request.expiresAt)}
            </p>
          )}
        </div>
      </Panel>

      {request.status === 'pending' && (
        <>
          <p className="mt-3 break-all text-center font-mono text-[0.6875rem] text-mono-400">
            {request.requestString.slice(0, 48)}…
          </p>

          {/* Copy alone on a desktop browser: the old fallback put a second
              "New request" here, next to the primary one below. */}
          <div
            className={`mt-3 grid gap-2 ${canShare ? 'grid-cols-2' : 'grid-cols-1'}`}
          >
            <Button variant="outline" onClick={copy}>
              <Copy className="mr-2 h-4 w-4" /> {copied ? 'Copied' : 'Copy'}
            </Button>
            {canShare && (
              <Button variant="outline" onClick={share}>
                <Share2 className="mr-2 h-4 w-4" /> Share
              </Button>
            )}
          </div>
        </>
      )}

      <div className="mt-4 space-y-2">
        <Button size="lg" className="w-full" onClick={onNew}>
          New request
        </Button>
        <Button variant="ghost" className="w-full" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  )
}
