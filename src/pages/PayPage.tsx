import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'

import { listVouchers } from '../lib/wallet'
import { toFarmers, type Farmer } from '../lib/farmers'
import { formatFace } from '../lib/format'
import { identityLabel, useIdentity } from '../lib/identity'
import { payRequest, splitObstacle } from '../lib/pay'
import type { NUT18VRequest } from '../lib/nap'
import { Button, Centered, Fatal, Alert } from '../components/ui'

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

  const [farmers, setFarmers] = useState<Farmer[] | null>(null)
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
    listVouchers().then((rows) => setFarmers(toFarmers(rows)))
  }, [])

  // Before the early returns, and so before `farmer` exists — hooks cannot be
  // called conditionally. It is the same fetch the farmer pages make, cached per
  // pubkey, so asking here costs nothing extra.
  const issuer = useIdentity(parsed.ok ? parsed.request.issuerId : undefined)

  if (!parsed.ok) return <Fatal title="Cannot read this request" detail={parsed.error} />
  const request = parsed.request

  if (farmers === null) return <Centered>Checking your coupons…</Centered>

  const farmer = farmers.find(
    (f) => f.pubkey.toLowerCase() === request.issuerId.toLowerCase(),
  )
  const group = farmer?.groups.find((g) => g.unit.toUpperCase() === request.unit.toUpperCase())
  const available = group?.totalFaceValue ?? 0
  // The farmer's own coupons name them too (`merchantName`), and that name is
  // there before any fetch — so it is the fallback while kind-0 is in flight, or
  // when they have published none.
  const issuerLabel = identityLabel(request.issuerId, {
    name: issuer?.name ?? farmer?.name,
    nip05: issuer?.nip05,
  })

  const expired = request.expiry !== undefined && request.expiry * 1000 < Date.now()
  const shortfall = request.amount - available
  // Same check payRequest selects with, so the button and the send agree on
  // what is payable — a coupon divisible on one and not the other would let the
  // user tap Pay only to be refused.
  const obstacle = group ? splitObstacle(group.vouchers, request.amount) : null
  const payable = !expired && !!farmer && !!group && shortfall <= 0 && !obstacle

  if (status.step === 'done') {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-5 text-center">
        <CheckCircle2 className="h-12 w-12 text-green-600" />
        <h1 className="text-xl font-semibold text-mono-900 dark:text-mono-50">Paid</h1>
        <p className="text-sm text-mono-500">
          {formatFace(request.amount, group)} to {issuerLabel}
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
      <p className="mb-6 text-sm text-mono-500">
        to {issuerLabel}
      </p>

      <div className="mb-6 rounded-2xl border border-mono-200 p-5 dark:border-mono-800">
        <p className="text-3xl font-semibold text-mono-900 dark:text-mono-50">
          {formatFace(request.amount, group ?? { unit: request.unit, decimals: request.decimals ?? 0 })}
        </p>
        {request.description && (
          <p className="mt-2 text-sm text-mono-500">{request.description}</p>
        )}
        <dl className="mt-4 space-y-1 text-sm">
          <Row label="Your balance" value={formatFace(available, group)} />
          <Row label="Coupons held" value={String(group?.voucherCount ?? 0)} />
        </dl>
      </div>

      {expired && <Alert>This payment request has expired.</Alert>}
      {!expired && !farmer && (
        <Alert>You have no coupons from this farmer.</Alert>
      )}
      {!expired && farmer && !group && (
        <Alert>You have no coupons from this farmer in {request.unit}.</Alert>
      )}
      {!expired && group && shortfall > 0 && (
        <Alert>Short by {formatFace(shortfall, group)}.</Alert>
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
            const reference = await payRequest({ request, raw, farmer: farmer!, payer: pubkey })
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
