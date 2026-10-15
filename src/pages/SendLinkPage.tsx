import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronRight, Link2 } from 'lucide-react'
import type { Voucher } from '@imani/voucher-send'

import { Alert, BackLink, Button, Centered, Input, PageHeader, Panel, Screen } from '../components/ui'
import { ClaimLinkPanel } from '../components/CashbackClaimLink'
import { formatFace, parseAmountToMinor, formatDate } from '../lib/format'
import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_CHOICES_DAYS,
  OWN_STALL_COPY,
  giftExclusion,
  giftExpiry,
} from '../lib/giftLink'
import { MAX_OUTSTANDING_LINKS, outstandingLinkCount, sendGift, tooManyLinksMessage } from '../lib/giftLinks'
import { useMerchantLabel } from '../lib/identity'
import { toMerchants, type Merchant } from '../lib/merchants'
import { SendOutcomeUnknownError, splitObstacle, withoutInFlight } from '../lib/pay'
import { listVouchers } from '../lib/wallet'
import { toEpochMs } from '../lib/format'

/**
 * Send by link (claim links phase 4, spec 4.2): "Anyone, by link".
 *
 * Pick a voucher (licences, terminal credentials, locked vouchers and the sender's own stall's
 * coupons excluded), an amount and how long the link lasts (Q3: 1, 7 or 30 days, default 7, never
 * past the coupon's own expiry), confirm, and get a link and QR. At most ten links may wait at once
 * (Q5). The link is shown here and in History, and never logged.
 */
type Option = { merchant: Merchant; unit: string; decimals: number; total: number; vouchers: Voucher[] }

function options(merchants: Merchant[], sender: string): { usable: Option[]; ownStall: boolean } {
  const byKey = new Map<string, Option>()
  let ownStall = false
  for (const merchant of merchants) {
    for (const group of merchant.groups) {
      const vouchers = group.vouchers.filter((v) => {
        const why = giftExclusion(v.token, v.issuer_id ?? merchant.pubkey, sender)
        if (why === 'own_stall') ownStall = true
        return why === null
      })
      if (vouchers.length === 0) continue
      const key = `${merchant.pubkey}|${group.unit.toUpperCase()}`
      const found = byKey.get(key)
      const total = vouchers.reduce((s, v) => s + (v.face_value ?? 0), 0)
      if (found) {
        found.total += total
        found.vouchers.push(...vouchers)
      } else {
        byKey.set(key, { merchant, unit: group.unit, decimals: group.decimals, total, vouchers })
      }
    }
  }
  return { usable: [...byKey.values()].sort((a, b) => b.total - a.total), ownStall }
}

export function SendLinkPage({ pubkey }: { pubkey: string }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  /**
   * The merchant already chosen on Send, when Send was opened from a merchant's page (owner report
   * 2026-10-14): asking "Which voucher?" again was confusing. Dropped by "Choose another voucher".
   */
  const [from, setFrom] = useState<string | null>(params.get('from'))
  const unit = params.get('unit')
  const back = params.get('from') ? `/send?from=${encodeURIComponent(params.get('from')!)}` : '/send'
  const [merchants, setMerchants] = useState<Merchant[] | null>(null)
  const [waiting, setWaiting] = useState<number | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [days, setDays] = useState<number>(DEFAULT_EXPIRY_DAYS)
  /** When Continue was tapped, ms: the expiry is fixed then, so the confirm screen and the send agree. */
  const [confirmedAt, setConfirmedAt] = useState<number | null>(null)
  const confirming = confirmedAt !== null
  const [status, setStatus] = useState<{ step: 'idle' | 'sending' } | { step: 'failed' | 'unconfirmed'; message: string }>({ step: 'idle' })
  const [sent, setSent] = useState<{ link: string; x: number; face: string; delivered: boolean } | null>(null)

  useEffect(() => {
    listVouchers().then((rows) => setMerchants(toMerchants(withoutInFlight(rows, pubkey))))
    void outstandingLinkCount().then(setWaiting, () => setWaiting(0))
  }, [pubkey])

  if (merchants === null || waiting === null) return <Centered>Checking your vouchers…</Centered>

  if (sent) {
    return (
      <Screen>
        <PageHeader title="Cashlink ready" subtitle={`${sent.face} · expires ${formatDate(sent.x * 1000)}`} />
        <Panel className="mb-4 p-5">
          <ClaimLinkPanel link={sent.link} expiresAt={sent.x * 1000} qrAlt="QR code to claim this Cashlink" />
        </Panel>
        {!sent.delivered && (
          <Alert>The Cashlink is made. Its voucher may take a moment to reach it, so it can be opened in a minute.</Alert>
        )}
        <p className="mb-4 text-xs text-mono-400">You can show it again, or take it back, from your history.</p>
        <Button size="lg" className="w-full" onClick={() => navigate('/')}>
          Done
        </Button>
      </Screen>
    )
  }

  if (waiting >= MAX_OUTSTANDING_LINKS) {
    return (
      <Screen>
        <BackLink to={back} label="Back" />
        <PageHeader title="Send a Cashlink" />
        <Alert>{tooManyLinksMessage()}</Alert>
      </Screen>
    )
  }

  const { usable: all, ownStall } = options(merchants, pubkey)
  if (from !== null) {
    const theirs = merchants.filter((m) => m.pubkey.toLowerCase() === from.toLowerCase())
    const mine = options(theirs, pubkey)
    if (mine.usable.length === 0) {
      // Say why for THIS merchant, rather than the whole picker or "no vouchers" (which may be untrue).
      const held = theirs.some((m) => m.groups.some((g) => g.vouchers.length > 0))
      return (
        <Screen>
          <BackLink to={back} label="Back" />
          <PageHeader title="Send a Cashlink" />
          <Alert>
            {mine.ownStall
              ? OWN_STALL_COPY
              : held
                ? 'None of your vouchers from this merchant can be sent as a Cashlink.'
                : 'You have no vouchers left from this merchant to send.'}
          </Alert>
          {all.length > 0 && (
            <Button variant="secondary" className="w-full" onClick={() => setFrom(null)}>
              Choose another voucher
            </Button>
          )}
        </Screen>
      )
    }
  }
  const narrowed = from === null ? all : all.filter((o) => o.merchant.pubkey.toLowerCase() === from.toLowerCase())
  const sameUnit = unit && from !== null ? narrowed.filter((o) => o.unit.toUpperCase() === unit.toUpperCase()) : []
  const usable = sameUnit.length > 0 ? sameUnit : narrowed
  if (usable.length === 0) {
    return (
      <Screen>
        <BackLink to={back} label="Back" />
        <PageHeader title="Send a Cashlink" />
        <Alert>{ownStall ? OWN_STALL_COPY : 'You have no vouchers to send.'}</Alert>
      </Screen>
    )
  }

  const chosen = usable.length === 1 ? usable[0] : usable.find((o) => key(o) === picked) ?? null

  if (chosen === null) {
    return (
      <Screen>
        <BackLink to={back} label="Back" />
        <PageHeader title="Which voucher?" subtitle="Send to anyone, as a Cashlink" />
        {ownStall && <p className="mb-3 text-sm text-mono-500">{OWN_STALL_COPY}</p>}
        <div className="space-y-2">
          {usable.map((o) => (
            <button
              key={key(o)}
              type="button"
              onClick={() => setPicked(key(o))}
              className="flex w-full items-center justify-between rounded-2xl bg-white p-4 text-left dark:bg-mono-900"
            >
              <div className="min-w-0">
                <MerchantText merchant={o.merchant} />
                <p className="text-sm text-mono-500">{formatFace(o.total, o)}</p>
              </div>
              <ChevronRight className="h-5 w-5 text-mono-400" />
            </button>
          ))}
        </div>
      </Screen>
    )
  }

  const minor = parseAmountToMinor(amount, chosen.decimals)
  const obstacle = minor === null || minor <= 0 ? null : splitObstacle(chosen.vouchers, minor)
  const short = minor !== null && minor > chosen.total
  const x = giftExpiry(confirmedAt ?? 0, days, chosen.vouchers.map((v) => toEpochMs(v.expires_at)))

  if (confirming && minor !== null) {
    const face = formatFace(minor, chosen)
    return (
      <Screen>
        <BackLink to="/" label="Cancel" />
        <PageHeader title="Confirm send" />
        <Panel className="mb-6 p-5">
          <p className="text-amount text-mono-900 dark:text-mono-50">{face}</p>
          <p className="mt-3 text-sm text-mono-700 dark:text-mono-200">
            Anyone with the link can claim {face} from <MerchantText merchant={chosen.merchant} />. You can take it back until it is
            claimed.
          </p>
          <p className="mt-2 text-sm text-mono-500">The link expires on {formatDate(x * 1000)}.</p>
        </Panel>
        {/* Spec 5.4: a handle binds the voucher to its recipient, a link does not. */}
        <p className="mb-4 text-xs text-mono-400">
          If you know their handle, send to them directly: nobody else can claim it.
        </p>
        {(status.step === 'failed' || status.step === 'unconfirmed') && <Alert>{status.message}</Alert>}
        <div className="space-y-2">
          <Button
            size="lg"
            className="w-full"
            disabled={status.step === 'sending' || status.step === 'unconfirmed'}
            onClick={async () => {
              setStatus({ step: 'sending' })
              try {
                const out = await sendGift({
                  payer: pubkey,
                  merchant: chosen.merchant,
                  unit: chosen.unit,
                  amount: minor,
                  memo: memo.trim() || undefined,
                  x,
                })
                setSent({ link: out.link, x: out.x, face: formatFace(out.result.delivered, chosen), delivered: out.delivered })
              } catch (e) {
                setStatus({
                  step: e instanceof SendOutcomeUnknownError ? 'unconfirmed' : 'failed',
                  message: e instanceof Error ? e.message : 'Send failed.',
                })
              }
            }}
          >
            {status.step === 'sending' ? 'Making the Cashlink…' : status.step === 'unconfirmed' ? 'Still going through' : 'Make Cashlink'}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            disabled={status.step === 'sending' || status.step === 'unconfirmed'}
            onClick={() => {
              setConfirmedAt(null)
              setStatus({ step: 'idle' })
            }}
          >
            Back
          </Button>
        </div>
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to={back} label="Back" />
      <PageHeader title="How much?" subtitle="Send to anyone, as a Cashlink" />
      <div className="space-y-4">
        <Input
          label={`Amount (${chosen.unit})`}
          inputMode={chosen.decimals > 0 ? 'decimal' : 'numeric'}
          placeholder={chosen.decimals > 0 ? '0.00' : '0'}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
        <p className="text-sm text-mono-500">
          {formatFace(chosen.total, chosen)} available from <MerchantText merchant={chosen.merchant} />
          {usable.length > 1 && (
            <>
              {' · '}
              <button type="button" className="underline" onClick={() => { setPicked(null); setAmount('') }}>
                change
              </button>
            </>
          )}
        </p>
        <div>
          <p className="mb-2 text-sm font-medium text-mono-700 dark:text-mono-200">Link expires in</p>
          <div className="flex gap-2" role="radiogroup" aria-label="Link expires in">
            {EXPIRY_CHOICES_DAYS.map((d) => (
              <Button
                key={d}
                type="button"
                role="radio"
                aria-checked={days === d}
                variant={days === d ? 'primary' : 'secondary'}
                size="sm"
                onClick={() => setDays(d)}
              >
                {d === 1 ? '1 day' : `${d} days`}
              </Button>
            ))}
          </div>
        </div>
        <Input label="Note (optional)" placeholder="Happy birthday" value={memo} onChange={(e) => setMemo(e.target.value)} />
        {short && <Alert>Short by {formatFace(minor - chosen.total, chosen)}.</Alert>}
        {!short && obstacle && <Alert>{obstacle}</Alert>}
        <Button
          size="lg"
          className="w-full"
          disabled={minor === null || minor <= 0 || short || !!obstacle}
          onClick={() => setConfirmedAt(Date.now())}
        >
          Continue
        </Button>
      </div>
    </Screen>
  )
}

/** The entry on Send's first step (spec 4.2 step 1). */
export function SendByLinkOption({ from, unit }: { from?: string | null; unit?: string | null } = {}) {
  const navigate = useNavigate()
  // Carries the merchant (and unit) Send already knows, so the link flow does not ask again.
  const query = from ? `?from=${encodeURIComponent(from)}${unit ? `&unit=${encodeURIComponent(unit)}` : ''}` : ''
  return (
    <button
      type="button"
      onClick={() => navigate(`/send/link${query}`)}
      className="mt-4 flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left dark:bg-mono-900"
    >
      <Link2 className="h-5 w-5 text-mono-500" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-mono-900 dark:text-mono-50">Anyone, as a Cashlink</p>
        <p className="text-sm text-mono-500">Make a link or QR anyone can claim</p>
      </div>
      <ChevronRight className="h-5 w-5 text-mono-400" />
    </button>
  )
}

function MerchantText({ merchant }: { merchant: Merchant }) {
  return <>{useMerchantLabel(merchant)}</>
}

function key(o: Option): string {
  return `${o.merchant.pubkey}|${o.unit.toUpperCase()}`
}
