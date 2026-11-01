import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Copy, Globe, TriangleAlert } from 'lucide-react'

import { Alert, BackLink, Button, Centered, DetailRow, IdentityInline, Input, Notice, PageHeader, Panel, Screen } from '../components/ui'
import { useMerchantLabel } from '../lib/identity'
import { listVouchers } from '../lib/wallet'
import { toMerchants } from '../lib/merchants'
import { fetchMerchantRecord } from '../lib/merchant'
import { formatFace, parseAmountToMinor } from '../lib/format'
import { checkoutPlan, maxExpiryFor, type CheckoutExclusion, type CheckoutPlan } from '../lib/checkoutPlan'
import { compact, display } from '../lib/checkoutCode'
import { loadCheckoutCodes, type CheckoutCodeRecord } from '../lib/checkoutCodeRecords'
import { cancelCheckoutCode, startCheckoutCode, type CheckoutPlanPart } from '../lib/checkoutCodeFlow'
import { appCheckoutPorts } from '../lib/checkoutCodePorts'
import { splitVoucher } from '../lib/voucherSplit'
import type { OnlineShop } from '../lib/onlineShop'
import type { VoucherRow } from '@imani/wallet-storage'

/**
 * "Use online" (#402): pick a stall with an online shop, an amount from that stall's coupons, an
 * expiry, and get a checkout code to type at the shop's checkout. One screen per step:
 * `/online` (stall), `/online?stall=<pk>` (amount and expiry), `/online/code/:id` (the code).
 *
 * Never starts from the wallet total: a coupon is honoured only by the stall that issued it, so the
 * figure shown is what THIS stall's shop can take, and the rest is explained.
 */

export interface OnlineStall {
  pubkey: string
  name: string
  shop: OnlineShop
}

/** Seams for tests. */
export interface UseOnlineDeps {
  rows: () => Promise<VoucherRow[]>
  shopOf: (stall: string) => Promise<OnlineShop | null>
  nowMs: () => number
  start: typeof startCheckoutCode
  cancel: typeof cancelCheckoutCode
  codes: (pubkey: string) => CheckoutCodeRecord[]
  ports: typeof appCheckoutPorts
  split: typeof splitVoucher
}

const realDeps: UseOnlineDeps = {
  rows: listVouchers,
  shopOf: async (stall) => (await fetchMerchantRecord(stall))?.onlineShop ?? null,
  nowMs: () => Date.now(),
  start: startCheckoutCode,
  cancel: cancelCheckoutCode,
  codes: loadCheckoutCodes,
  ports: appCheckoutPorts,
  split: splitVoucher,
}

const DAY_S = 86_400
export const EXPIRY_CHOICES = [1, 7, 30] as const

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

const EXCLUSION_WORDS: Record<CheckoutExclusion, string> = {
  wrong_stall: '',
  wrong_unit: 'is in another currency',
  in_flight: 'is still being sent or is in another code',
  already_locked: 'is already locked',
  not_lockable: 'cannot be used online',
  expires_too_soon: 'expires too soon to use online',
}

export function UseOnlinePage({ pubkey, deps = realDeps }: { pubkey: string; deps?: UseOnlineDeps }) {
  const { id } = useParams()
  const [params] = useSearchParams()
  if (id) return <CodeScreen pubkey={pubkey} id={id} deps={deps} />
  const stall = params.get('stall')
  if (stall) return <AmountScreen pubkey={pubkey} stall={stall.toLowerCase()} deps={deps} />
  return <StallPicker deps={deps} />
}

function StallPicker({ deps }: { deps: UseOnlineDeps }) {
  const navigate = useNavigate()
  const [stalls, setStalls] = useState<OnlineStall[] | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      const merchants = toMerchants(await deps.rows())
      const found = await Promise.all(merchants.map(async (m) => ({ m, shop: await deps.shopOf(m.pubkey).catch(() => null) })))
      if (live) setStalls(found.filter((f) => f.shop).map((f) => ({ pubkey: f.m.pubkey, name: f.m.name, shop: f.shop! })))
    })()
    return () => {
      live = false
    }
  }, [deps])

  if (stalls === null) return <Centered>Looking for stalls that sell online…</Centered>
  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Use online" subtitle="Pick the stall whose shop you are buying from." />
      {stalls.length === 0 ? (
        <Notice tone="warning">
          {/* Only coupons you can still spend count: one already in a checkout code, or used, is not
              here (staging 2026-10-31: read as "the shop is not online"). */}
          No coupon you can spend comes from a stall that sells online. Coupons already in a checkout code
          are not counted.
        </Notice>
      ) : (
        <div className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
          {stalls.map((s) => (
            <button
              key={s.pubkey}
              type="button"
              className="press-row flex w-full items-center gap-3 p-4 text-left"
              onClick={() => navigate(`/online?stall=${s.pubkey}`)}
            >
              <span className="min-w-0 flex-1">
                <IdentityInline pubkey={s.pubkey} fallbackName={s.name} linkToProfile={false} />
              </span>
              <span className="flex shrink-0 items-center gap-1 text-sm text-mono-500">
                <Globe className="h-4 w-4" aria-hidden /> {hostOf(s.shop.url)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Screen>
  )
}

function AmountScreen({ pubkey, stall, deps }: { pubkey: string; stall: string; deps: UseOnlineDeps }) {
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState<{ rows: VoucherRow[]; shop: OnlineShop | null; nowS: number } | null>(null)
  const [amountText, setAmountText] = useState('')
  const [days, setDays] = useState<number>(7)
  const [busy, setBusy] = useState<false | 'splitting' | 'making'>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void Promise.all([deps.rows(), deps.shopOf(stall).catch(() => null)]).then(([rows, shop]) => {
      if (live) setLoaded({ rows, shop, nowS: Math.floor(deps.nowMs() / 1000) })
    })
    return () => {
      live = false
    }
  }, [deps, stall])

  const group = useMemo(() => {
    if (!loaded) return undefined
    return toMerchants(loaded.rows).find((m) => m.pubkey.toLowerCase() === stall)?.groups[0]
  }, [loaded, stall])
  // The stall's own name (kind 0, then the coupon's issuer name), never its key (#402 review).
  const stallName = useMerchantLabel({ pubkey: stall, name: group?.merchantName })

  if (!loaded) return <Centered>Checking your vouchers…</Centered>
  if (!loaded.shop) {
    return (
      <Screen>
        <BackLink to={`/merchants/${stall}`} label="Back" />
        <Alert>This stall does not sell online.</Alert>
      </Screen>
    )
  }
  const shop = loaded.shop
  const unit = group?.unit ?? 'EUR'
  const decimals = group?.decimals ?? 2
  const denom = { unit, decimals }
  const x = loaded.nowS + days * DAY_S
  const amount = parseAmountToMinor(amountText, decimals) ?? 0
  const plan: CheckoutPlan = checkoutPlan({ rows: loaded.rows, payer: pubkey, stallId: stall, unit, amount, x, nowS: loaded.nowS })
  const usable = plan.usable.reduce((n, c) => n + c.faceValue, 0)
  const latest = maxExpiryFor(plan.plan ?? plan.usable, loaded.nowS)
  const offered = EXPIRY_CHOICES.filter((d) => latest !== null && loaded.nowS + d * DAY_S <= latest)
  const excluded = new Map<CheckoutExclusion, number>()
  for (const e of plan.excluded) {
    if (e.reason === 'wrong_stall') continue
    excluded.set(e.reason, (excluded.get(e.reason) ?? 0) + (e.row.face_value ?? 0))
  }

  const obstacle = amount <= 0 ? null : plan.obstacle
  const obstacleText =
    obstacle?.kind === 'insufficient_value'
      ? `Only ${formatFace(obstacle.available, denom)} can be used at ${hostOf(shop.url)}.`
      : obstacle?.kind === 'not_splittable'
        ? 'Your vouchers cannot make exactly this amount. Try a nearby amount.'
        : obstacle?.kind === 'too_many_parts'
          ? 'This needs too many vouchers for one code. Try a smaller amount.'
          : obstacle?.kind === 'expiry_window'
            ? 'Pick a shorter expiry.'
            : null

  const splitting = plan.plan?.find((p) => p.needsSplit)

  /** The split part replaced by the coupons the split made, or a sentence saying what happened. */
  const runSplit = async (ports: ReturnType<typeof deps.ports>): Promise<CheckoutPlanPart[] | string> => {
    if (!splitting) return []
    const out = await deps.split(ports, pubkey, { tokenId: splitting.row.token_id, token: splitting.row.token, amount: splitting.amount })
    if (out.kind === 'split') return out.parts
    if (out.kind === 'refused') return 'Your voucher could not be split right now. Nothing has changed.'
    if (out.kind === 'kept_as_sats') return 'Your voucher could not be split. Its value is still in your wallet, now as sats.'
    return 'Your voucher is being split. It is safe, and it finishes the next time Imani opens. Try again in a moment.'
  }

  const onGet = async () => {
    if (!plan.plan) return
    setBusy(splitting ? 'splitting' : 'making')
    setError(null)
    try {
      const ports = deps.ports()
      const made = await runSplit(ports)
      if (typeof made === 'string') {
        setError(made)
        return
      }
      setBusy('making')
      const parts: CheckoutPlanPart[] = plan.plan.flatMap((p) =>
        p.needsSplit ? made : [{ tokenId: p.row.token_id, token: p.row.token, amount: p.amount, faceValue: p.faceValue }],
      )
      const out = await deps.start({
        ports,
        pubkey,
        stall,
        shop,
        unit,
        decimals,
        amount,
        x,
        parts,
      })
      if (out.kind === 'issued' || out.kind === 'pending') navigate(`/online/code/${out.record.id}`)
      else if (splitting) setError('Your voucher was split, but no code could be made. Both parts are in your wallet.')
      else setError(out.kind === 'refused' ? 'These vouchers cannot be used online right now. Nothing has changed.' : 'No code could be made. Your vouchers come back on their own when the expiry passes.')
      // #402: the split's change is locked to this wallet's own key; make it an ordinary coupon again
      // now, so the next send can draw on it. The catch-up sweep finishes it if this is cut short.
      if (splitting) void import('../lib/selfLockedCouponsApp').then((m) => m.unlockSelfLockedCouponsNow(pubkey)).catch(() => 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Nothing has changed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <BackLink to={`/merchants/${stall}`} label="Back" />
      <PageHeader title="Coupon code" subtitle={`${stallName} · to spend at ${hostOf(shop.url)}`} />
      {/* The one figure that matters, large, as on the coupon itself; why the rest cannot go
          follows in small type, beside the figure it explains. */}
      <Panel className="p-5">
        <p className="text-sm text-mono-500">Usable at {hostOf(shop.url)}</p>
        <p className="text-amount tracking-tight text-mono-900 dark:text-mono-50">{formatFace(usable, denom)}</p>
        {[...excluded.entries()].map(([reason, minor]) => (
          <p key={reason} className="mt-1 text-xs text-mono-600 dark:text-mono-400">
            {formatFace(minor, denom)} {EXCLUSION_WORDS[reason]}
          </p>
        ))}
      </Panel>

      <div className="mt-6 space-y-5">
        <Input
          label={`Amount (${unit})`}
          className="text-lg"
          inputMode={decimals > 0 ? 'decimal' : 'numeric'}
          placeholder={decimals > 0 ? '0.00' : '0'}
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          aria-describedby={obstacleText ? 'online-obstacle' : undefined}
          autoFocus
        />
        {/* Validated as the amount is typed, never after Get code: the shopper sees why the
            button is off while the figure is still in front of them. */}
        {obstacleText && (
          <p id="online-obstacle" role="status" className="-mt-3 text-sm text-amber-700 dark:text-amber-300">
            {obstacleText}
          </p>
        )}
        {amount > 0 && splitting && (
          <p className="-mt-3 text-sm text-mono-600 dark:text-mono-400">Imani will split a voucher to make this amount.</p>
        )}

        <div>
          <p className="mb-2 text-sm font-medium text-mono-600 dark:text-mono-400">Code expires in</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Code expires in">
            {EXPIRY_CHOICES.map((d) => {
              const ok = offered.includes(d)
              return (
                <Button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={d === days}
                  size="sm"
                  variant={d === days ? 'primary' : 'secondary'}
                  className={ok ? undefined : 'opacity-40'}
                  disabled={!ok}
                  onClick={() => setDays(d)}
                >
                  {d === 1 ? '1 day' : `${d} days`}
                </Button>
              )
            })}
          </div>
          {offered.length < EXPIRY_CHOICES.length && <p className="mt-2 text-xs text-mono-600 dark:text-mono-400">A voucher's own expiry limits how long the code can last.</p>}
        </div>

        {error && <Alert>{error}</Alert>}
        <Button size="lg" className="w-full" disabled={!plan.plan || busy !== false || !offered.includes(days as 1 | 7 | 30)} onClick={() => void onGet()}>
          {busy === 'splitting' ? 'Splitting your voucher…' : busy ? 'Making your code…' : 'Get code'}
        </Button>
        {busy && (
          <p className="text-center text-xs text-mono-400" role="status" aria-live="polite">
            This takes a few seconds. Do not close this screen.
          </p>
        )}
      </div>
    </Screen>
  )
}

function CodeScreen({ pubkey, id, deps }: { pubkey: string; id: string; deps: UseOnlineDeps }) {
  const [record, setRecord] = useState<CheckoutCodeRecord | undefined>(() => deps.codes(pubkey).find((r) => r.id === id))
  const [copied, setCopied] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const stallName = useMerchantLabel({ pubkey: record?.stall ?? '' })
  if (!record) return <Centered>No such code.</Centered>
  const shop = hostOf(record.shopUrl)
  const denom = { unit: record.unit, decimals: record.decimals }
  const expires = new Date(record.x * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  if (!record.code) {
    return (
      <Screen>
        <BackLink to={`/merchants/${record.stall}`} label="Done" />
        <PageHeader title="Your code" subtitle={`${stallName} · for ${shop}`} />
        <Notice tone="warning">
          {record.status === 'abandoned'
            ? `No code was made. Your vouchers come back on their own by ${expires}.`
            : 'Still making your code. Keep Imani open; it carries on where it stopped.'}
        </Notice>
      </Screen>
    )
  }
  const shown = record.platform === 'shopify' ? compact(record.code) : display(record.code)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(shown)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const onCancel = async () => {
    setCancelError(null)
    setCancelling(true)
    try {
      const out = await deps.cancel(deps.ports(), pubkey, record.id)
      if (out.ok) {
        setConfirmCancel(false)
        setRecord(deps.codes(pubkey).find((r) => r.id === id))
      } else setCancelError(out.why === 'HELD' ? 'This code is in a checkout right now. Try again once the cart is closed.' : 'The code could not be cancelled. Try again in a moment.')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <Screen>
      <BackLink to={`/merchants/${record.stall}`} label="Done" />
      <PageHeader title="Your code" subtitle={`Only works at ${shop}`} />
      <Panel className="p-5 text-center">
        <p className="break-all font-mono text-2xl font-semibold tracking-wider text-mono-900 dark:text-mono-50" data-testid="checkout-code">
          {shown}
        </p>
        <Button variant="outline" className="mt-4" onClick={() => void onCopy()}>
          <Copy className="mr-2 h-4 w-4" aria-hidden /> {copied ? 'Copied' : 'Copy'}
        </Button>
      </Panel>
      <Panel className="mt-4 p-4">
        <DetailRow label="Amount" value={formatFace(record.amount, denom)} />
        <DetailRow label="Stall" value={stallName} />
        <DetailRow label="Shop" value={shop} />
        <DetailRow label="Expires" value={expires} />
        <DetailRow label="Status" value={STATUS_WORDS[record.status] ?? record.status} />
      </Panel>
      {record.status === 'cancelling' && <Notice tone="warning">Cancelling. Your money is back within 24 hours, or on {expires} at the latest.</Notice>}
      {cancelError && <Alert>{cancelError}</Alert>}
      {record.status === 'reserved' && !confirmCancel && (
        <Button variant="ghost" className="mt-4 w-full" onClick={() => setConfirmCancel(true)}>
          Cancel code
        </Button>
      )}
      {record.status === 'reserved' && confirmCancel && (
        // Asked at the decision, not after it, as Revoke on Terminals asks: amber, a consequence to
        // read rather than an error. Keeping the code is first and plain, so a thumb that lands by
        // habit lands on the safe answer.
        <div role="alertdialog" aria-labelledby="cancel-code-title" className="expand-row mt-4 rounded-xl bg-amber-50 p-4 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <div className="flex gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="text-sm">
              <p id="cancel-code-title" className="font-medium">Cancel this code?</p>
              <p className="mt-1">
                It stops working at {shop} straight away. Your {formatFace(record.amount, denom)} comes back to your
                wallet within 24 hours, or on {expires} at the latest.
              </p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmCancel(false)} disabled={cancelling}>
              Keep it
            </Button>
            <Button
              size="sm"
              onClick={() => void onCancel()}
              disabled={cancelling}
              className="!bg-red-600 !text-white hover:!bg-red-700"
            >
              {cancelling ? 'Cancelling…' : 'Cancel code'}
            </Button>
          </div>
        </div>
      )}
    </Screen>
  )
}

const STATUS_WORDS: Partial<Record<CheckoutCodeRecord['status'], string>> = {
  reserved: 'Ready to use',
  held: 'In a checkout',
  cancelling: 'Cancelling',
  redeemed: 'Used',
  cancelled: 'Cancelled',
  expired: 'Expired',
  depositing: 'Being made',
  locking: 'Being made',
  abandoned: 'Not made',
}
