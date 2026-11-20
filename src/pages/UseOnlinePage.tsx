import { useEffect, useMemo, useState } from 'react'
import { checkoutRefusalMessage } from '../lib/checkoutRefusal'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Copy, ExternalLink, Globe } from 'lucide-react'

import { Alert, BackLink, Button, Centered, DetailRow, IdentityInline, Input, Notice, PageHeader, Panel, Screen } from '../components/ui'
import { humanName } from '../lib/identity'
import { getTransactionRow, listVouchers } from '../lib/wallet'
import { toMerchants } from '../lib/merchants'
import { fetchMerchantRecord } from '../lib/merchant'
import { formatFace, parseAmountToMinor } from '../lib/format'
import { availableOf, checkoutPlan, maxExpiryFor, type CheckoutExclusion, type CheckoutPlan } from '../lib/checkoutPlan'
import { display } from '../lib/checkoutCode'
import { reconcileCheckoutCodesNow } from '../lib/checkoutCodesApp'
import { loadCheckoutCodes, remainingOf, type CheckoutCodeRecord } from '../lib/checkoutCodeRecords'
import { CHECKOUT_CODES_PATH, startCheckoutCode, type CheckoutPlanPart } from '../lib/checkoutCodeFlow'
import { asCheckoutCodeSnapshot, checkoutTxId, CHECKOUT_STATUS_WORDS } from '../lib/checkoutCodeHistory'
import { appCheckoutPorts } from '../lib/checkoutCodePorts'
import { splitVoucher } from '../lib/voucherSplit'
import { warmMint } from '../lib/cashlinkFlow'
import { trustedMintUrls } from '../lib/trustedMint'
import type { OnlineShop } from '../lib/onlineShop'
import { stallAcceptsNewCheckoutCodes } from '../lib/stallCheckoutCodes'
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
  /** #639: false when the stall's plan takes no new checkout codes; null when not known. */
  acceptsNew: boolean | null
}

/** #639: the reason Get code is off, the words the lock's refusal would have used. */
export const NOT_IN_PLAN_TEXT = checkoutRefusalMessage({ kind: 'refused', why: 'not_in_plan' })

/** Seams for tests. */
export interface UseOnlineDeps {
  rows: () => Promise<VoucherRow[]>
  shopOf: (stall: string) => Promise<OnlineShop | null>
  nowMs: () => number
  start: typeof startCheckoutCode
  codes: (pubkey: string) => CheckoutCodeRecord[]
  ports: typeof appCheckoutPorts
  split: typeof splitVoucher
  /** #477: open the mint connection and read its keyset while the amount is typed. */
  warm?: () => void
  /** #557: the code's History row, for a code whose record is not on this device. */
  historyRow?: (txId: string) => Promise<Record<string, unknown> | null>
  /** #557: the store's `GET /mine`, for that code's current status. Null when it did not answer. */
  mine?: () => Promise<Array<Record<string, unknown>> | null>
  /** #405: one catch-up pass (`/mine`), so a Shopify code waiting for its shop turns ready. */
  reconcile?: (pubkey: string) => Promise<number>
  /**
   * #639: whether the stall's shop takes new checkout codes. Null (or absent, or throwing) is
   * unknown: Get code stays on and the lock decides. Only false turns it off.
   */
  acceptsNew?: (stall: string) => Promise<boolean | null>
}

const askAcceptsNew = (deps: UseOnlineDeps, stall: string): Promise<boolean | null> =>
  (deps.acceptsNew ?? (async () => null))(stall).catch(() => null)

const realDeps: UseOnlineDeps = {
  rows: listVouchers,
  shopOf: async (stall) => (await fetchMerchantRecord(stall))?.onlineShop ?? null,
  nowMs: () => Date.now(),
  start: startCheckoutCode,
  codes: loadCheckoutCodes,
  ports: appCheckoutPorts,
  split: splitVoucher,
  historyRow: async (txId) => ((await getTransactionRow(txId)) as unknown as Record<string, unknown> | null) ?? null,
  mine: async () => {
    const answer = await appCheckoutPorts().store.call('GET', `${CHECKOUT_CODES_PATH}/mine`)
    if (answer.status !== 200) return null
    const body = answer.body as unknown
    if (Array.isArray(body)) return body as Array<Record<string, unknown>>
    const codes = (body as { codes?: unknown } | null)?.codes
    return Array.isArray(codes) ? (codes as Array<Record<string, unknown>>) : null
  },
  warm: () => {
    for (const url of trustedMintUrls()) warmMint(url)
  },
  reconcile: reconcileCheckoutCodesNow,
  acceptsNew: (stall) => stallAcceptsNewCheckoutCodes(stall),
}

/** #405: how often, and how long, a code waiting for its shop is re-checked. */
export const SHOP_READY_POLL_MS = 3_000
export const SHOP_READY_GIVE_UP_MS = 120_000

const DAY_S = 86_400
export const EXPIRY_CHOICES = [1, 7, 30] as const

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** Only an `https:` address becomes a link; anything else is no address at all. */
const httpsUrl = (url: string | undefined): string | null => {
  if (!url) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * The shop, as a link out. The host is what reads (a full URL with a path is noise at this size);
 * the full address stays the href and the title. A new tab, so the wallet (and a code half-made in
 * it) stays where it was.
 */
export function ShopLink({ url, className = '' }: { url: string | undefined; className?: string }) {
  const href = httpsUrl(url)
  if (!href) return <span className={`text-mono-500 ${className}`}>Not recorded</span>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      data-testid="shop-link"
      className={`pressable inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium text-mono-900 underline-offset-4 hover:underline dark:text-mono-50 ${className}`}
    >
      <Globe className="h-4 w-4 shrink-0 text-mono-500" aria-hidden />
      <span className="truncate">{hostOf(href)}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-mono-400" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}

/**
 * Who the code is for: the stall, as the app shows a stall everywhere else (avatar, name, handle),
 * and its shop beneath it. `linkToProfile` is off where leaving would lose a half-typed amount.
 */
function StallCard({ stall, fallbackName, shopUrl, linkToProfile }: { stall: string; fallbackName?: string; shopUrl: string | undefined; linkToProfile: boolean }) {
  return (
    <div className="mb-6 divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800" data-testid="stall-card">
      <div className="p-4">
        <IdentityInline pubkey={stall} fallbackName={fallbackName} size="md" linkToProfile={linkToProfile} />
      </div>
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <span className="shrink-0 text-sm text-mono-500">Shop</span>
        <ShopLink url={shopUrl} className="text-sm" />
      </div>
    </div>
  )
}

const EXCLUSION_WORDS: Record<CheckoutExclusion, string> = {
  wrong_stall: '',
  wrong_unit: 'is in another currency',
  in_flight: 'is still being sent or is in another code',
  already_locked: 'is already locked',
  not_lockable: 'cannot be used online',
  expires_too_soon: 'expires too soon to use online',
  not_splittable_for_shop: 'cannot be used at this shop',
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
      const found = await Promise.all(
        merchants.map(async (m) => {
          const shop = await deps.shopOf(m.pubkey).catch(() => null)
          return { m, shop, acceptsNew: shop ? await askAcceptsNew(deps, m.pubkey) : null }
        }),
      )
      if (live) setStalls(found.filter((f) => f.shop).map((f) => ({ pubkey: f.m.pubkey, name: f.m.name, shop: f.shop!, acceptsNew: f.acceptsNew })))
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
              className="press-row flex w-full flex-wrap items-center gap-3 p-4 text-left"
              onClick={() => navigate(`/online?stall=${s.pubkey}`)}
            >
              <span className="min-w-0 flex-1">
                <IdentityInline pubkey={s.pubkey} fallbackName={s.name} linkToProfile={false} />
              </span>
              <span className="flex shrink-0 items-center gap-1 text-sm text-mono-500">
                <Globe className="h-4 w-4" aria-hidden /> {hostOf(s.shop.url)}
              </span>
              {s.acceptsNew === false && (
                <span className="basis-full text-xs text-amber-700 dark:text-amber-300" data-testid="not-in-plan">
                  {NOT_IN_PLAN_TEXT}
                </span>
              )}
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
  // #639: asked alongside, never waited on: until it answers, Get code behaves as before.
  const [acceptsNew, setAcceptsNew] = useState<boolean | null>(null)
  const [amountText, setAmountText] = useState('')
  const [days, setDays] = useState<number>(7)
  const [busy, setBusy] = useState<false | 'splitting' | 'making'>(false)
  const [error, setError] = useState<string | null>(null)
  // #477: by the time "Get code" is pressed, the mint's connection is open and its keyset known.
  useEffect(() => {
    try {
      deps.warm?.()
    } catch {
      // A head start only.
    }
  }, [deps])

  useEffect(() => {
    let live = true
    void Promise.all([deps.rows(), deps.shopOf(stall).catch(() => null)]).then(([rows, shop]) => {
      if (live) setLoaded({ rows, shop, nowS: Math.floor(deps.nowMs() / 1000) })
    })
    void askAcceptsNew(deps, stall).then((answer) => {
      if (live) setAcceptsNew(answer)
    })
    return () => {
      live = false
    }
  }, [deps, stall])

  const group = useMemo(() => {
    if (!loaded) return undefined
    return toMerchants(loaded.rows).find((m) => m.pubkey.toLowerCase() === stall)?.groups[0]
  }, [loaded, stall])

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
  const plan: CheckoutPlan = checkoutPlan({ rows: loaded.rows, payer: pubkey, stallId: stall, unit, amount, x, nowS: loaded.nowS, requireSplittable: shop.platform === 'shopify' })
  const usable = availableOf(plan.usable)
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

  const notInPlan = acceptsNew === false
  const onGet = async () => {
    if (!plan.plan || notInPlan) return
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
      else setError(checkoutRefusalMessage(out))
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
      <PageHeader title="Coupon code" subtitle="A code to type at the shop's checkout." />
      {/* Who it is for, as the app names a stall everywhere else, and the shop one tap away. Not a
          link to the profile: a tap there would lose the amount being typed. */}
      <StallCard stall={stall} fallbackName={humanName(group?.merchantName)} shopUrl={shop.url} linkToProfile={false} />
      {/* The one figure that matters, large, as on the coupon itself; why the rest cannot go
          follows in small type, beside the figure it explains. */}
      <Panel className="p-5">
        <p className="truncate text-sm text-mono-500" title={shop.url}>
          Usable at {hostOf(shop.url)}
        </p>
        <p className="mt-1 text-amount tracking-tight tabular-nums text-mono-900 dark:text-mono-50">{formatFace(usable, denom)}</p>
        {excluded.size > 0 && (
          <div className="mt-2 space-y-0.5">
            {[...excluded.entries()].map(([reason, minor]) => (
              <p key={reason} className="text-xs text-mono-600 dark:text-mono-400">
                {formatFace(minor, denom)} {EXCLUSION_WORDS[reason]}
              </p>
            ))}
          </div>
        )}
      </Panel>

      <div className="mt-8 space-y-6">
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
        {notInPlan && !error && (
          <p id="online-not-in-plan" role="status" className="text-sm text-amber-700 dark:text-amber-300" data-testid="not-in-plan">
            {NOT_IN_PLAN_TEXT}
          </p>
        )}
        <Button size="lg" className="w-full" aria-describedby={notInPlan ? 'online-not-in-plan' : undefined} disabled={notInPlan || !plan.plan || busy !== false || !offered.includes(days as 1 | 7 | 30)} onClick={() => void onGet()}>
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
  const [gaveUp, setGaveUp] = useState(false)
  const waiting = record?.shopReady === false
  // #405: a Shopify code is hidden until the shop has made its gift card; re-check until it has.
  useEffect(() => {
    if (!waiting) return
    let stopped = false
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      await deps.reconcile?.(pubkey).catch(() => 0)
      if (stopped) return
      const now = deps.codes(pubkey).find((r) => r.id === id)
      if (now && now.shopReady !== false) return setRecord({ ...now })
      if (++tries * SHOP_READY_POLL_MS >= SHOP_READY_GIVE_UP_MS) return setGaveUp(true)
      timer = setTimeout(() => void tick(), SHOP_READY_POLL_MS)
    }
    timer = setTimeout(() => void tick(), SHOP_READY_POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [waiting, deps, pubkey, id])
  if (!record) return <CodeFromHistory id={id} deps={deps} />
  const shop = hostOf(record.shopUrl)
  const denom = { unit: record.unit, decimals: record.decimals }
  const expires = new Date(record.x * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

  if (!record.code) {
    return (
      <Screen>
        <BackLink to={`/merchants/${record.stall}`} label="Done" />
        <PageHeader title="Your code" subtitle={record.shopUrl ? `For ${shop}` : undefined} />
        <StallCard stall={record.stall} shopUrl={record.shopUrl} linkToProfile />
        <Notice tone="warning">
          {record.status === 'abandoned'
            ? `No code was made. Your vouchers come back on their own by ${expires}.`
            : 'Still making your code. Keep Imani open; it carries on where it stopped.'}
        </Notice>
      </Screen>
    )
  }
  if (record.shopReady === false) {
    return (
      <Screen>
        <BackLink to={`/merchants/${record.stall}`} label="Done" />
        <PageHeader title="Your code" subtitle={record.shopUrl ? `Only works at ${shop}` : undefined} />
        <StallCard stall={record.stall} shopUrl={record.shopUrl} linkToProfile />
        <Notice tone="warning">
          <span data-testid="shop-preparing">
            {gaveUp ? 'Still preparing. Keep Imani open; it carries on where it stopped.' : `Preparing your code for ${shop}…`}
          </span>
        </Notice>
      </Screen>
    )
  }
  // #405: Shopify's checkout takes the hyphenated form too (dev store, 2026-11-11).
  const shown = display(record.code)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(shown)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const amountWords =
    remainingOf(record) === record.amount || record.status === 'redeemed'
      ? formatFace(record.amount, denom)
      : `${formatFace(remainingOf(record), denom)} left of ${formatFace(record.amount, denom)}`
  return (
    <Screen>
      <BackLink to={`/merchants/${record.stall}`} label="Done" />
      <PageHeader title="Your code" subtitle={record.shopUrl ? `Only works at ${shop}` : undefined} />
      {/* The code is the one thing to act on: large, monospaced, Copy directly beneath it. */}
      <Panel className="mb-6 px-5 py-6 text-center">
        <p className="break-all font-mono text-[1.375rem] font-semibold leading-snug tracking-wide text-mono-900 dark:text-mono-50" data-testid="checkout-code">
          {shown}
        </p>
        <Button size="lg" className="mt-5 w-full" onClick={() => void onCopy()}>
          <Copy className="mr-2 h-4 w-4" aria-hidden /> {copied ? 'Copied' : 'Copy'}
        </Button>
      </Panel>
      <StallCard stall={record.stall} shopUrl={record.shopUrl} linkToProfile />
      <section className="mb-6 divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800">
        <DetailRow label="Amount" value={amountWords} />
        <DetailRow label="Expires" value={expires} />
        <DetailRow label="Status" value={STATUS_WORDS[record.status] ?? record.status} />
      </section>
      {(record.redemptions?.length ?? 0) > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-mono-500">Used</h2>
          <ul
            data-testid="redemptions"
            className="divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 text-sm dark:divide-mono-800 dark:border-mono-800"
          >
            {record.redemptions!.map((u, n) => (
              <li key={n} className="flex items-baseline justify-between gap-4 p-4">
                <span className="text-mono-500">{new Date(u.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <span className="text-right tabular-nums text-mono-900 dark:text-mono-50">
                  {formatFace(u.amount, denom)} used, {formatFace(u.remaining, denom)} left
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {record.status === 'cancelling' && <Notice tone="warning">Cancelling. Your money is back within 24 hours, or on {expires} at the latest.</Notice>}
      {(record.status === 'reserved' || record.status === 'held' || record.status === 'settling') && (
        <p className="text-sm leading-relaxed text-mono-500" data-testid="bearer-note">
          Anyone with this code can use the rest until {expires}; whatever is left then comes back to you.
        </p>
      )}
    </Screen>
  )
}

/**
 * #557: a code whose record is not on this device (a login on a new device before the backup came
 * back, or a record that was never backed up). What its History row says, and its status from the
 * store's `/mine` when it answers, instead of a dead end.
 */
function CodeFromHistory({ id, deps }: { id: string; deps: UseOnlineDeps }) {
  const [state, setState] = useState<{ row: Record<string, unknown> | null; status?: string } | 'loading'>('loading')
  useEffect(() => {
    let live = true
    void (async () => {
      const row = await (deps.historyRow ?? (async () => null))(checkoutTxId(id)).catch(() => null)
      if (live) setState({ row })
      const mine = await (deps.mine ?? (async () => null))().catch(() => null)
      const entry = mine?.find((e) => e.idempotency_key === id)
      if (live && typeof entry?.status === 'string') setState({ row, status: entry.status })
    })()
    return () => {
      live = false
    }
  }, [id, deps])
  if (state === 'loading') return <Centered>Loading…</Centered>
  const { row } = state
  if (!row) return <Centered>No such code.</Centered>
  const snap = asCheckoutCodeSnapshot(row.checkoutCode)
  const denom = { unit: String(row.unit ?? ''), decimals: Number(row.decimals ?? 0) }
  const amount = typeof row.amount === 'number' ? formatFace(row.amount, denom) : 'Not recorded'
  const stall = typeof row.merchantId === 'string' ? row.merchantId : undefined
  const when = typeof row.timestamp === 'number' ? new Date(row.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded'
  const status = state.status ?? snap?.status
  const statusWords = status ? (CHECKOUT_STATUS_WORDS as Record<string, string>)[status] ?? status : 'Not known'
  return (
    <Screen>
      <BackLink to={stall ? `/merchants/${stall}` : '/'} label="Done" />
      <PageHeader title="Your code" subtitle={snap?.shopHost ? `For ${snap.shopHost}` : undefined} />
      {stall && <StallCard stall={stall} shopUrl={snap?.shopHost ? `https://${snap.shopHost}` : undefined} linkToProfile />}
      <section className="mb-6 divide-y divide-mono-200 overflow-hidden rounded-2xl border border-mono-200 dark:divide-mono-800 dark:border-mono-800" data-testid="code-from-history">
        <DetailRow label="Amount" value={amount} />
        <DetailRow label="Made" value={when} />
        <DetailRow label="Status" value={statusWords} />
      </section>
      <Notice tone="warning">The details of this code are not on this device, so its code cannot be shown here.</Notice>
    </Screen>
  )
}

const STATUS_WORDS: Partial<Record<CheckoutCodeRecord['status'], string>> = {
  reserved: 'Ready to use',
  held: 'In a checkout',
  settling: 'In a checkout',
  cancelling: 'Cancelling',
  redeemed: 'Used',
  cancelled: 'Cancelled',
  expired: 'Expired',
  depositing: 'Being made',
  locking: 'Being made',
  abandoned: 'Not made',
}
