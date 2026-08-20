import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import { getDecimals } from '@imani/money'

import { listVouchers } from '../lib/wallet'
import { toMerchants, type Merchant } from '../lib/merchants'
import { formatFace } from '../lib/format'
import { identityLabel, identitySubLabel, useIdentity } from '../lib/identity'
import { payRequest, splitObstacle } from '../lib/pay'
import type { NUT18VRequest } from '../lib/nap'
import { Avatar, Button, Centered, Fatal, Alert } from '../components/ui'

type Status =
  | { step: 'review' }
  | { step: 'paying' }
  | { step: 'done'; reference: string }
  | { step: 'failed'; message: string }

/**
 * Confirmation for a scanned voucher payment request, then the payment itself.
 */
export function PayPage({ pubkey }: { pubkey: string }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const raw = params.get('paymentRequest') ?? ''

  const [merchants, setMerchants] = useState<Merchant[] | null>(null)
  // When this screen loaded, in ms. The clock is read in the effect below and
  // kept here because `Date.now()` in a render body is impure — the same rule
  // MerchantHomePage's expiry list follows. Zero until the load lands, which
  // never renders: the screen shows "Checking your coupons…" until then.
  const [loadedAt, setLoadedAt] = useState(0)
  const [status, setStatus] = useState<Status>({ step: 'review' })

  type Parsed = { ok: true; request: NUT18VRequest } | { ok: false; error: string }

  const parsed = useMemo<Parsed>(() => {
    if (!raw) return { ok: false, error: 'No payment request.' }
    const nut = window.NUT18V
    if (!nut) return { ok: false, error: 'Payment request parser unavailable.' }
    try {
      return { ok: true, request: nut.parse(raw) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Unreadable payment request.' }
    }
  }, [raw])

  useEffect(() => {
    listVouchers().then((rows) => {
      setMerchants(toMerchants(rows))
      setLoadedAt(Date.now())
    })
  }, [])

  // Before the early returns, and so before `merchant` exists — hooks cannot be
  // called conditionally. It is the same fetch the merchant pages make, cached per
  // pubkey, so asking here costs nothing extra.
  const issuer = useIdentity(parsed.ok ? parsed.request.issuerId : undefined)

  if (!parsed.ok) return <Fatal title="Cannot read this request" detail={parsed.error} />
  const request = parsed.request

  if (merchants === null) return <Centered>Checking your vouchers…</Centered>

  const merchant = merchants.find(
    (f) => f.pubkey.toLowerCase() === request.issuerId.toLowerCase(),
  )
  const group = merchant?.groups.find((g) => g.unit.toUpperCase() === request.unit.toUpperCase())
  const available = group?.totalFaceValue ?? 0
  // How to read `request.amount`, which is MINOR UNITS.
  //
  // The NUT-18V wire carries no decimals at all — round-tripping a request
  // through the shim returns `{paymentId, issuerId, amount, unit, singleUse,
  // offlineVerification, mints, expiresAt, transports}` and nothing else — so
  // the old `request.decimals ?? 0` fallback was always 0, and a £1.00 request
  // read as "100 GBP" for anyone not already holding this merchant's coupons.
  // The currency registry is the same source VoucherGrouper resolves group
  // decimals from, so the two halves of this screen agree; the group still wins
  // when there is one, because a merchant may trade in a unit registered at
  // runtime that the registry does not know.
  const denom = group ?? { unit: request.unit, decimals: getDecimals(request.unit) }
  // The merchant's own coupons name them too (`merchantName`), and that name is
  // there before any fetch — so it is the fallback while kind-0 is in flight, or
  // when they have published none.
  const issuerIdentity = {
    name: issuer?.name ?? merchant?.name,
    nip05: issuer?.nip05,
    picture: issuer?.picture,
  }
  const issuerLabel = identityLabel(request.issuerId, issuerIdentity)

  // `expiresAt` is what the parser emits, in SECONDS. This read `request.expiry`
  // — a name nothing writes — so `expired` was permanently false and a lapsed
  // request stayed payable: the customer's coupons went out against a request
  // the issuer had already timed out.
  const expired = request.expiresAt !== undefined && request.expiresAt * 1000 < loadedAt
  const shortfall = request.amount - available
  // Same check payRequest selects with, so the button and the send agree on
  // what is payable — a coupon divisible on one and not the other would let the
  // user tap Pay only to be refused.
  const obstacle = group ? splitObstacle(group.vouchers, request.amount) : null
  const payable = !expired && !!merchant && !!group && shortfall <= 0 && !obstacle

  if (status.step === 'done') {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-5 text-center">
        <CheckCircle2 className="h-12 w-12 text-green-600" />
        <h1 className="text-xl font-semibold text-mono-900 dark:text-mono-50">Paid</h1>
        <p className="text-sm text-mono-500">
          {formatFace(request.amount, denom)} to {issuerLabel}
        </p>
        <p className="font-mono text-xs text-mono-400">{status.reference}</p>
        <Button className="mt-4 w-full" onClick={() => navigate('/')}>
          Done
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md p-5">
      <button
        onClick={() => navigate('/')}
        className="mb-4 flex items-center gap-1 text-sm text-mono-500"
      >
        <ArrowLeft className="h-4 w-4" /> Cancel
      </button>

      <h1 className="mb-1 text-xl font-semibold text-mono-900 dark:text-mono-50">
        Confirm payment
      </h1>
      {/* Who is being paid, named the way every other screen names them —
          picture, display name, handle underneath. The label doubles as the
          avatar's alt text and initials, so an issuer with no picture still
          reads as themselves rather than as a stray letter. */}
      <div className="mb-6 flex items-center gap-3">
        <Avatar
          src={issuerIdentity.picture}
          name={issuerLabel}
          pubkey={request.issuerId}
          size="md"
          className="shrink-0"
        />
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-mono-400">To</p>
          <p className="truncate text-sm text-mono-900 dark:text-mono-50">{issuerLabel}</p>
          {identitySubLabel(issuerIdentity) && (
            <p className="truncate text-xs text-mono-500">{identitySubLabel(issuerIdentity)}</p>
          )}
        </div>
      </div>

      <div className="mb-6 rounded-2xl border border-mono-200 p-5 dark:border-mono-800">
        <p className="text-3xl font-semibold text-mono-900 dark:text-mono-50">
          {formatFace(request.amount, denom)}
        </p>
        {request.description && (
          <p className="mt-2 text-sm text-mono-500">{request.description}</p>
        )}
        <dl className="mt-4 space-y-1 text-sm">
          <Row label="Your balance" value={formatFace(available, denom)} />
          <Row label="Vouchers held" value={String(group?.voucherCount ?? 0)} />
        </dl>
      </div>

      {expired && <Alert>This payment request has expired.</Alert>}
      {!expired && !merchant && (
        <Alert>You have no vouchers from this shop.</Alert>
      )}
      {!expired && merchant && !group && (
        <Alert>You have no coupons from this shop in {request.unit}.</Alert>
      )}
      {!expired && group && shortfall > 0 && (
        <Alert>Short by {formatFace(shortfall, denom)}.</Alert>
      )}
      {/* Holding enough is not the same as being able to pay it: a coupon
          cannot be divided below one sat's worth of face value. Surfaced here
          so the obstacle is visible before the tap, not thrown afterwards. */}
      {!expired && group && shortfall <= 0 && obstacle && <Alert>{obstacle}</Alert>}
      {status.step === 'failed' && <Alert>{status.message}</Alert>}

      <Button
        size="lg"
        className="mt-4 w-full"
        disabled={!payable || status.step === 'paying'}
        onClick={async () => {
          setStatus({ step: 'paying' })
          try {
            const reference = await payRequest({ request, raw, merchant: merchant!, payer: pubkey })
            setStatus({ step: 'done', reference })
          } catch (e) {
            setStatus({
              step: 'failed',
              message: e instanceof Error ? e.message : 'Payment failed.',
            })
          }
        }}
      >
        {status.step === 'paying' ? 'Paying…' : 'Pay'}
      </Button>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-mono-500">{label}</dt>
      <dd className="text-mono-900 dark:text-mono-50">{value}</dd>
    </div>
  )
}
