import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Check, Copy, Share2 } from 'lucide-react'
import QRCode from 'qrcode'

import { Button, Screen, BackLink, PageHeader, Alert, Panel, Input } from '../components/ui'
import { RefusedCouponsNote } from '../components/ui/RefusedCouponsNote'
import { currencyDecimals, formatFace, parseAmountToMinor, formatDate } from '../lib/format'
import type { MerchantProfile } from '../lib/merchant'
import { issuingStall, type Actor } from '../lib/actor'
import {
  createRequest,
  expireRequests,
  loadRequests,
  partialFor,
  reconcileRequests,
  saveRequests,
  type VoucherPaymentRequest,
} from '../lib/vreq'
import { onWalletChanged } from '../lib/wallet'
import {
  paidForStall,
  watchFulfilment,
  type FulfilmentCheck,
  type RequestRegistration,
} from '../lib/terminalTill'
import { RECEIVE_TROUBLE_CHANGED, receiveTroubleFor, type ReceiveTrouble } from '../lib/receiveTrouble'
import { userMessage } from '../lib/userMessage'

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
export function RedeemPage({
  pubkey,
  merchant,
  actor,
  fulfilment,
  register,
}: {
  pubkey: string
  merchant: MerchantProfile
  /**
   * The terminal taking payment, if this device is one.
   *
   * Absent on the stall's own device. This screen used to BUILD an owner actor
   * unconditionally, which on a terminal names the wrong recipient — and the
   * comment below already says what that costs: money arriving somewhere
   * nobody can decrypt it.
   */
  actor?: Actor
  /**
   * Asks gateway-core whether the request was paid (#160 phase 3, G12; #300).
   *
   * On a terminal it is the ONLY way to learn it: the request names the STALL, so the customer's
   * coupon goes to the stall's key and a terminal's own wallet never sees it. On the stall's own
   * device it runs beside the wallet (#300): the till shows Paid as soon as core counts the
   * payment, even while the coupon's receive into this wallet is still pending or stalled.
   */
  fulfilment?: FulfilmentCheck
  /**
   * Registers the request's terms with gateway-core before the code is shown (#160 review,
   * BLOCKER). gateway-core measures payments against these terms, first registration wins, so
   * they must be in before a customer can read the id. Core's verdict is only trusted for a
   * request whose terms this device registered.
   */
  register?: RequestRegistration
}) {
  const navigate = useNavigate()
  const [request, setRequest] = useState<VoucherPaymentRequest | null>(null)
  /** Whether gateway-core holds THIS request's terms, so its verdict can be trusted. */
  const [coreHeld, setCoreHeld] = useState(false)
  // A terminal has no wallet the payment reaches; the stall's own device does.
  const ownWallet = actor?.kind !== 'terminal'

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Redeem" subtitle={request ? undefined : 'What does the customer owe?'} />

      {request === null ? (
        <RequestForm
          merchant={merchant}
          issuerPubkey={pubkey}
          actor={actor}
          register={register}
          ownWallet={ownWallet}
          onCreated={(created, held) => {
            setCoreHeld(held)
            setRequest(created)
          }}
        />
      ) : (
        <RequestDisplay
          pubkey={pubkey}
          stallPubkey={actor?.stallPubkey ?? pubkey}
          fulfilment={coreHeld ? fulfilment : undefined}
          coreUnavailable={ownWallet && !!fulfilment && !coreHeld}
          ownWallet={ownWallet}
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
  actor,
  register,
  ownWallet,
  onCreated,
}: {
  merchant: MerchantProfile
  issuerPubkey: string
  actor?: Actor
  register?: RequestRegistration
  ownWallet: boolean
  /** `held`: gateway-core holds this request's terms, so its verdict may be asked. */
  onCreated: (request: VoucherPaymentRequest, held: boolean) => void
}) {
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ISO decimals, which is what the sats backing needs — see currencyDecimals.
  // The gateway labels every coupon 2-decimal regardless; that mismatch is its
  // bug, and matching it here costs a hundredfold over-backing and a 413.
  const decimals = currencyDecimals(merchant.issuanceCurrency)
  const minor = parseAmountToMinor(amount, decimals)

  const submit = async () => {
    if (minor === null) return
    setError(null)
    setBusy(true)
    try {
      const created = createRequest({
        amount: minor,
        unit: merchant.issuanceCurrency,
        // The ACTOR, so the recipient is the stall rather than whoever is
        // signed in. On this device they are the same key; on a terminal they
        // are not, and the difference is money arriving somewhere nobody can
        // decrypt it.
        actor: actor ?? { kind: 'owner', stallPubkey: issuerPubkey },
        description: memo,
      })
      // The terms go in BEFORE the code is on screen (#160 review, BLOCKER): gateway-core keeps
      // the first registration, and once the id is visible a customer could register their own.
      let held = false
      if (register) {
        held = await register({
          paymentId: created.paymentId,
          // The stall the request names: the terminal's stall, never the device.
          issuerId: actor ? issuingStall(actor) : issuerPubkey,
          amount: created.amount,
          unit: created.unit,
        })
        // A terminal can only ever learn Paid from core, so a request core will not hold could
        // never be confirmed and is not shown. The stall's own device still sees the payment
        // arrive in its wallet, so it shows the code and simply does not ask core (#300).
        if (!held && !ownWallet) {
          setError('This payment request could not be set up. Check the connection and try again.')
          return
        }
        if (!held) {
          console.warn(
            '[redeem] #300 gateway-core does not hold this request; Paid will come from this wallet alone',
          )
        }
      }
      // Persisted before it is shown: a request the merchant is looking at but
      // that was never stored cannot be matched against an incoming payment
      // after a reload.
      const stored = expireRequests(loadRequests(issuerPubkey))
      saveRequests(issuerPubkey, [created, ...stored].slice(0, 50))
      onCreated(created, held)
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
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
      <Button size="lg" className="w-full" disabled={minor === null || busy} onClick={() => void submit()}>
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
  stallPubkey,
  fulfilment,
  coreUnavailable,
  ownWallet,
  request,
  onChange,
  onNew,
  onDone,
}: {
  pubkey: string
  stallPubkey: string
  /** Given only when gateway-core holds this request's terms. */
  fulfilment?: FulfilmentCheck
  /**
   * The stall's own device could not register the terms (#307 review), so Paid can only come from
   * this wallet receiving the coupons, as before #300. Said quietly on the till.
   */
  coreUnavailable: boolean
  /** The payment reaches this device's wallet: the stall's own device, not a terminal. */
  ownWallet: boolean
  request: VoucherPaymentRequest
  onChange: (request: VoucherPaymentRequest) => void
  onNew: () => void
  onDone: () => void
}) {
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** Minor units received against this request so far, when it is not yet paid. */
  const [received, setReceived] = useState(0)
  /** Receives of this request's coupons that failed after core counted the payment (#300). */
  const [troubles, setTroubles] = useState<ReceiveTrouble[]>([])
  // Paid on core's verdict, and no arrival covering it has been filed against it yet (#300).
  const awaitingCoupons =
    ownWallet && request.status === 'fulfilled' && request.confirmedBy === 'core' && !request.settledBy
  // From the request rather than the stall: a request already carries the unit
  // it was created with, and re-reading the merchant record here would relabel
  // an open request if the currency were changed in settings mid-sale.
  const decimals = currencyDecimals(request.unit)

  useEffect(() => {
    // The QR encodes the `cashu:` URI rather than the bare `vreqA…`, so a
    // general-purpose scanner can route it to a wallet instead of showing text.
    QRCode.toDataURL(request.clickableUri, { width: 320, margin: 1 }).then(setQr, () => setQr(null))
  }, [request.clickableUri])

  // Ask gateway-core until the request is paid or expires, backing off, then stop (spec 2.5,
  // #300). On a terminal this is the only way to learn it. On the stall's own device it runs
  // beside the wallet, so a receive that stalls cannot hold the till on "Waiting for payment"
  // when core has already counted the money.
  useEffect(() => {
    if (!fulfilment || request.status !== 'pending') return
    const replace = (next: VoucherPaymentRequest) =>
      saveRequests(pubkey, loadRequests(pubkey).map((r) => (r.paymentId === request.paymentId ? next : r)))
    return watchFulfilment({
      paymentId: request.paymentId,
      check: fulfilment,
      // Checked against THIS request: the money must have reached the stall, in the stall's own
      // coupons, in this unit, and at least this amount (#160 review, BLOCKER).
      isPaid: (answer) => paidForStall(answer, stallPubkey, request),
      expiresAtMs: request.expiresAt * 1000,
      onPaid: (answer) => {
        // The wallet may have settled it first, while core was being asked. Its record (which
        // transaction paid) is kept: one payment, one settlement.
        const stored = loadRequests(pubkey).find((r) => r.paymentId === request.paymentId)
        if (stored && stored.status !== 'pending') {
          onChange(stored)
          return
        }
        // Recorded so the request list agrees with the screen after a reload. `confirmedBy`
        // says the coupons may still be on their way, and stops a later arrival naming this
        // request from settling a different one (matchPayment).
        const paid: VoucherPaymentRequest = {
          ...request,
          status: 'fulfilled',
          confirmedBy: 'core',
          ...(typeof answer.amount === 'number' ? { receivedAmount: answer.amount } : {}),
        }
        replace(paid)
        onChange(paid)
      },
      onExpired: () => {
        const expired = { ...request, status: 'expired' as const }
        replace(expired)
        onChange(expired)
      },
    })
  }, [fulfilment, request, pubkey, stallPubkey, onChange])

  // The stall's own device: watch the wallet. While the request is open this is how a payment
  // is seen when core cannot be asked; once core has said Paid it is how the till learns the
  // coupons themselves arrived (#300). A terminal's wallet never receives them.
  const watchWallet = ownWallet && (request.status === 'pending' || awaitingCoupons)
  useEffect(() => {
    if (!watchWallet) return

    let live = true

    // The settling itself is the wallet's job, not this screen's — the same
    // reconcile runs on unlock and on every wallet change (lib/vreq.ts), which
    // is what lets a merchant leave this screen and still get paid. All that is
    // left here is reading back what it decided about THIS request.
    const check = async () => {
      try {
        const { requests, arrivals } = await reconcileRequests(pubkey)
        if (!live) return
        const mine = requests.find((r) => r.paymentId === request.paymentId)
        // Settled by the wallet while open, or (after a Paid from core) its coupons filed
        // against it by the reconcile: either way, the stored record is the truth.
        if (mine && (request.status === 'pending' ? mine.status !== 'pending' : !!mine.settledBy)) {
          onChange(mine)
          return
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

    // Runs once on mount as well as on every change, because the payment can
    // land between the request being shown and this effect subscribing.
    void check()
    const unsubscribe = onWalletChanged(() => void check())

    // Expiry is a clock event, not a wallet event, so it needs its own timer.
    // The reconcile is what writes the status; this only wakes it up.
    const timer = setInterval(() => {
      if (request.status === 'pending' && request.expiresAt * 1000 <= Date.now()) void check()
    }, 5000)

    return () => {
      live = false
      unsubscribe()
      clearInterval(timer)
    }
  }, [watchWallet, request, pubkey, onChange])

  // A receive that fails after core said Paid is the merchant's to know about (#300): the money
  // is counted, the coupons are their custody. Read back from what dm-poll recorded.
  useEffect(() => {
    if (!ownWallet) return
    const refresh = () => setTroubles(receiveTroubleFor(pubkey, request.paymentId))
    refresh()
    window.addEventListener(RECEIVE_TROUBLE_CHANGED, refresh)
    return () => window.removeEventListener(RECEIVE_TROUBLE_CHANGED, refresh)
  }, [ownWallet, pubkey, request.paymentId])

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

          {/* A coupon naming this request was refused before the swap (#145).
              Nobody has paid yet, so no payer is known to vouch for: shown
              neutrally, and only while the request is still open. */}
          <RefusedCouponsNote
            pubkey={pubkey}
            requestId={request.paymentId}
            pending={request.status === 'pending'}
            className="mt-3 text-left"
          />

          {/* Core could not be asked about this request (#307 review): the till still works, but
              only through this wallet's receive, so a stalled receive would hold it. A fact, in
              the same quiet caption as the "still receiving" note. */}
          {request.status === 'pending' && coreUnavailable && (
            <p className="mt-3 text-xs text-mono-500">
              Paid will show once the coupons reach this wallet.
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
              {/* Paid on gateway-core's count while the coupons are still on their way into
                  this wallet (#300). Quiet, because nothing is wrong: the sale is done and the
                  customer can go. It disappears once the coupons land. */}
              {awaitingCoupons && troubles.length === 0 && (
                <p className="mt-3 text-xs text-mono-500" role="status">
                  Payment confirmed. Still receiving the coupons.
                </p>
              )}
            </div>
          )}

          {/* The receive failed after the payment was counted (#300). Paid stays: the money is
              counted by gateway-core. The coupons are the merchant's to collect, so say so on
              the sale itself, in the same amber strip as the other payment warnings. */}
          {awaitingCoupons && troubles.length > 0 && (
            <div
              role="status"
              className="mt-3 flex gap-2 rounded-xl bg-amber-50 p-3 text-left text-sm text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{troubleLine(troubles)}</p>
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

/**
 * What to tell the merchant when the coupons of a sale core already counted did not arrive
 * (#300). A fact and the next step, never a reason to take the goods back: the customer paid.
 */
function troubleLine(troubles: readonly ReceiveTrouble[]): string {
  if (troubles.some((t) => t.kind === 'unsaved')) {
    return 'Paid, but the coupons have not reached this wallet. The payment is safe at the gateway and needs reconciling: check Transactions later.'
  }
  // #314: "will keep trying" is a promise, so it is made only when the wallet will try again (it
  // does, in this session). A coupon that can never be received gets the plain fact instead.
  if (troubles.some((t) => t.kind === 'failed' && t.retryable === false)) {
    return PERMANENT_RECEIVE_FAILURE
  }
  return RETRYING_RECEIVE_FAILURE
}

/** The receive will be tried again (#314). */
const RETRYING_RECEIVE_FAILURE =
  'Paid, but the coupons have not reached this wallet yet. The wallet will keep trying. If they do not appear, check Transactions later.'

/** The receive will not be tried again (#307 review, #314). The customer still paid. */
const PERMANENT_RECEIVE_FAILURE =
  'Paid, but these coupons could not be added to this wallet, and trying again will not help. The customer has paid. Check Transactions, and contact support if you need help.'
