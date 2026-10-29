import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { CreditCard, Pencil } from 'lucide-react'

import { Alert, Centered, Panel, Screen } from '@wallet/components/ui/layout'
import { Button } from '@wallet/components/ui/Button'
import { Avatar } from '@wallet/components/ui/Avatar'
import { fetchMerchantRecord } from '@wallet/lib/merchant'
import { merchantBranding } from '@wallet/lib/branding'
import { getDecimals } from '@imani/money'

import { ApiError, CODES, COPY, giftingApi } from '../lib/api'
import {
  claimDeadline,
  draftMatches,
  draftRequest,
  EMPTY_FORM,
  FROM_MAX,
  isExpired,
  keep,
  MESSAGE_MAX,
  recall,
  termsVersion,
  toMinorUnits,
  validate,
  type DeliveryKind,
  type Draft,
  type FormErrors,
  type GiftForm,
} from '../lib/draft'
import { displayHandle, normaliseRecipientHandle } from '../lib/handle'
import { newGiftSecrets, returnLink, seal } from '../lib/gift'
import { loadShop, robotsFor, SHOP_COPY, type Shop, type ShopState } from '../lib/shop'
import { WALLET_ORIGIN } from '../lib/signer'
import type { Account } from '../lib/session'

const api = giftingApi()

const shopDeps = {
  resolve: api.resolve,
  record: fetchMerchantRecord,
  branding: async (pubkey: string) => {
    const b = await merchantBranding(pubkey)
    return { name: b.organizationName, picture: b.logoUrl, about: b.storeDescription }
  },
}

function money(minor: number, currency: string): string {
  const d = safeDecimals(currency)
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 10 ** d)
  } catch {
    return `${(minor / 10 ** d).toFixed(d)} ${currency}`
  }
}

function safeDecimals(currency: string): number {
  try {
    return getDecimals(currency)
  } catch {
    return 2
  }
}

const day = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

/** Set the robots meta (G1) and the title for this shop. */
function useHead(state: ShopState | null) {
  useEffect(() => {
    const robots = document.getElementById('robots')
    const index = state ? robotsFor(state) === 'index' : false
    robots?.setAttribute('content', index ? 'index, follow' : 'noindex')
    if (state && 'shop' in state) document.title = `${state.shop.name} vouchers · Imani gifts`
  }, [state])
}

export function ShopPage({ session, step }: { session: Account | null; step: 'form' | 'review' }) {
  const { handle = '' } = useParams()
  const navigate = useNavigate()
  const [attempt, setAttempt] = useState(0)
  // Keyed by what was asked, so a new handle or a retry reads as "loading" without a reset.
  const [answer, setAnswer] = useState<{ key: string; state: ShopState } | null>(null)
  const asked = `${handle}#${attempt}`

  useEffect(() => {
    let live = true
    loadShop(handle, shopDeps).then((s) => live && setAnswer({ key: `${handle}#${attempt}`, state: s }))
    return () => {
      live = false
    }
  }, [handle, attempt])
  const state = answer?.key === asked ? answer.state : null
  useHead(state)

  if (state === null) return <Centered>Loading the shop…</Centered>
  if (state.kind === 'redirect') return <RedirectTo to={step === 'review' ? `${state.to}/review` : state.to} />
  if (state.kind === 'invalid') return <Message text={SHOP_COPY.invalid} />
  if (state.kind === 'not-found')
    return (
      <Message text={SHOP_COPY.notFound}>
        {state.retryable && (
          <Button className="mt-4" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        )}
      </Message>
    )
  if (state.kind === 'paused') return <ShopHeader shop={state.shop}><p className="text-callout text-mono-500">{SHOP_COPY.paused(state.shop.name)}</p></ShopHeader>
  if (state.kind === 'no-cards') return <ShopHeader shop={state.shop}><p className="text-callout text-mono-500">{SHOP_COPY.noCards(state.shop.name)}</p></ShopHeader>

  return (
    <GiftFlow
      key={state.shop.pubkey}
      shop={state.shop}
      session={session}
      step={step}
      goReview={() => navigate(`/shop/${state.shop.canonical}/review`)}
      goForm={(field) => navigate(`/shop/${state.shop.canonical}${field ? `#${field}` : ''}`)}
    />
  )
}

function RedirectTo({ to }: { to: string }) {
  const navigate = useNavigate()
  const { hash } = useLocation()
  useEffect(() => {
    void navigate(to + hash, { replace: true })
  }, [navigate, to, hash])
  return null
}

function Message({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <Screen>
      <h1 className="mb-2 mt-8 text-title font-semibold">{text}</h1>
      {children}
    </Screen>
  )
}

function ShopHeader({ shop, children }: { shop: Shop; children?: React.ReactNode }) {
  const r = shop.record
  return (
    <Screen>
      <div className="mb-4 mt-4 flex items-center gap-3">
        <Avatar src={shop.branding.picture} name={shop.name} />
        <div className="min-w-0">
          <h1 className="truncate text-title font-semibold">{shop.name}</h1>
          <p className="text-sm text-mono-500">{displayHandle(shop.nip05)}</p>
        </div>
      </div>
      {(shop.branding.about || r.storeDescription) && <p className="mb-2 text-callout">{shop.branding.about || r.storeDescription}</p>}
      {r.location && <p className="mb-2 text-sm text-mono-500">{r.location}</p>}
      <p className="mb-6 text-sm text-mono-500">
        Vouchers in {r.issuanceCurrency.toUpperCase()},{' '}
        {r.voucherValidityDays ? `valid for ${r.voucherValidityDays} days` : 'with no expiry'}, spent at {shop.name}.
      </p>
      {children}
    </Screen>
  )
}

type Resolved = { kind: 'idle' } | { kind: 'checking' } | { kind: 'none' } | { kind: 'ok'; pubkey: string; name?: string; picture?: string }

function useResolvedHandle(raw: string): Resolved {
  const nip05 = normaliseRecipientHandle(raw)
  const [answer, setAnswer] = useState<{ nip05: string; r: Resolved } | null>(null)
  useEffect(() => {
    if (!nip05) return
    let live = true
    const done = (r: Resolved) => live && setAnswer({ nip05, r })
    // Debounced: one lookup when they stop typing (§2).
    const t = setTimeout(() => {
      api
        .resolve(nip05)
        .then(async (pubkey) => {
          if (!pubkey) return done({ kind: 'none' })
          const b = await merchantBranding(pubkey).catch(() => ({}) as { organizationName?: string; logoUrl?: string })
          done({ kind: 'ok', pubkey, name: b.organizationName, picture: b.logoUrl })
        })
        .catch(() => done({ kind: 'none' }))
    }, 400)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [nip05])
  if (!nip05) return { kind: 'idle' }
  return answer?.nip05 === nip05 ? answer.r : { kind: 'checking' }
}

function GiftFlow({
  shop,
  session,
  step,
  goReview,
  goForm,
}: {
  shop: Shop
  session: Account | null
  step: 'form' | 'review'
  goReview: () => void
  goForm: (field?: string) => void
}) {
  const kept = useMemo(() => recall(shop.canonical), [shop.canonical])
  const [form, setForm] = useState<GiftForm>(kept?.form ?? EMPTY_FORM)
  const [touched, setTouched] = useState(false)
  const signedIn = session !== null
  const decimals = safeDecimals(shop.record.issuanceCurrency)
  const errors = validate(form, { signedIn, decimals, stallNip05: shop.nip05 })
  const resolved = useResolvedHandle(form.deliver === 'handle' ? form.handle : '')

  useEffect(() => keep(shop.canonical, { ...(recall(shop.canonical) ?? {}), form }), [shop.canonical, form])
  // "From" defaults to nothing for a guest; prefilled from the profile once signed in.
  useEffect(() => {
    if (!session || form.from) return
    merchantBranding(session.pubkey).then((b) => b.organizationName && setForm((f) => (f.from ? f : { ...f, from: b.organizationName ?? '' })), () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  const handleProblem =
    form.deliver === 'handle' && resolved.kind === 'none'
      ? "We couldn't find that handle."
      : form.deliver === 'handle' && resolved.kind === 'ok' && resolved.pubkey === shop.pubkey
        ? `You can't send a ${shop.name} voucher to ${shop.name}.`
        : undefined
  const canReview = Object.keys(errors).length === 0 && !handleProblem && (form.deliver !== 'handle' || resolved.kind === 'ok')

  if (step === 'review') {
    if (Object.keys(errors).length > 0) return <RedirectTo to={`/shop/${shop.canonical}`} />
    return <Review shop={shop} form={form} session={session} goForm={goForm} />
  }

  const set = (patch: Partial<GiftForm>) => setForm((f) => ({ ...f, ...patch }))
  const show = (field: keyof FormErrors) => (touched ? errors[field] : undefined)

  return (
    <ShopHeader shop={shop}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          setTouched(true)
          if (canReview) goReview()
        }}
      >
        <Field id="amount" label={`Amount (${shop.record.issuanceCurrency.toUpperCase()})`} error={show('amount')}>
          <input id="amount" inputMode="decimal" autoComplete="off" className={inputClass} value={form.amount} placeholder="25.00" onChange={(e) => set({ amount: e.target.value })} />
        </Field>

        <fieldset id="deliver" className="mb-4">
          <legend className="mb-2 block text-sm font-medium">Deliver to</legend>
          {(
            [
              ['handle', "Someone's handle"],
              ['email', 'An email address'],
            ] as Array<[DeliveryKind, string]>
          ).map(([kind, label]) => (
            <label key={kind} className="mb-2 flex items-center gap-2 text-callout">
              <input type="radio" name="deliver" value={kind} checked={form.deliver === kind} onChange={() => set({ deliver: kind })} /> {label}
            </label>
          ))}
          {show('deliver') && <p className="text-sm text-red-600">{errors.deliver}</p>}
        </fieldset>

        {form.deliver === 'handle' && (
          <Field id="handle" label="Their handle" error={show('handle') ?? handleProblem}>
            <input id="handle" autoComplete="off" autoCapitalize="none" className={inputClass} value={form.handle} placeholder="name@domain" onChange={(e) => set({ handle: e.target.value })} />
            {resolved.kind === 'checking' && <p className="mt-1 text-sm text-mono-500">Looking them up…</p>}
            {resolved.kind === 'ok' && resolved.pubkey !== shop.pubkey && (
              <div className="mt-2 flex items-center gap-2 text-sm" data-testid="resolved-recipient">
                <Avatar src={resolved.picture} name={resolved.name ?? normaliseRecipientHandle(form.handle) ?? ''} />
                <span>
                  {/* Who this is, by name and handle: what a buyer can check. Never a key. */}
                  <span className="font-medium">{resolved.name ?? displayHandle(normaliseRecipientHandle(form.handle) ?? '')}</span>{' '}
                  {resolved.name && <span className="text-mono-500">{displayHandle(normaliseRecipientHandle(form.handle) ?? '')}</span>}
                </span>
              </div>
            )}
          </Field>
        )}

        {form.deliver === 'email' && (
          <Field id="email" label="Their email address" error={show('email')}>
            <input id="email" type="email" autoComplete="off" className={inputClass} value={form.email} placeholder="name@example.com" onChange={(e) => set({ email: e.target.value })} />
          </Field>
        )}

        <Field id="message" label="Message (optional)" error={show('message')}>
          <textarea id="message" maxLength={MESSAGE_MAX + 20} rows={3} className={inputClass} value={form.message} onChange={(e) => set({ message: e.target.value })} />
          <p className="mt-1 text-right text-xs text-mono-500">
            {form.message.length}/{MESSAGE_MAX}
          </p>
        </Field>

        <Field id="from" label="From (optional)" error={show('from')}>
          <input id="from" maxLength={FROM_MAX} className={inputClass} value={form.from} placeholder={signedIn ? '' : 'Your name, or leave blank'} onChange={(e) => set({ from: e.target.value })} />
        </Field>

        <Field id="buyerEmail" label="Your email" error={show('buyerEmail')}>
          <input id="buyerEmail" type="email" autoComplete="email" className={inputClass} value={form.buyerEmail} onChange={(e) => set({ buyerEmail: e.target.value })} />
          <p className="mt-1 text-xs text-mono-500">
            {signedIn
              ? 'For your receipt, and to tell you when it is claimed or if it is not.'
              : 'For your receipt, your link to take the gift back, and to tell you when it is claimed or if it is not.'}
          </p>
        </Field>

        <p className="mb-4 text-xs text-mono-500">
          We keep the recipient&apos;s email and your message only as long as delivery and the claim window need them. {shop.name} gets no buyer or
          recipient details from Imani. Stripe, as {shop.name}&apos;s card processor, shares the card payment details it collects with them.
        </p>

        <Button type="submit" size="lg" className="w-full" disabled={touched && !canReview}>
          Review
        </Button>
      </form>
    </ShopHeader>
  )
}

const inputClass =
  'w-full rounded-xl border border-mono-200 bg-transparent px-4 py-3 text-callout outline-none transition-colors duration-100 ease-out placeholder:text-mono-400 focus:border-mono-400 dark:border-mono-800 dark:focus:border-mono-600'

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="mb-2 block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
      {error && (
        <p className="mt-1 text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

type ReviewState =
  | { kind: 'preparing' }
  | { kind: 'ready'; draft: Draft; refundSecret?: string }
  | { kind: 'error'; message: string; retry: boolean }
  | { kind: 'paying'; draft: Draft; refundSecret?: string }

/**
 * The review page: creating the draft is entering it (§3). The server re-checks everything and
 * pins the recipient; what it answers is what is shown, and checked against what was asked.
 */
function Review({
  shop,
  form,
  session,
  goForm,
}: {
  shop: Shop
  form: GiftForm
  session: Account | null
  goForm: (field?: string) => void
}) {
  const [state, setState] = useState<ReviewState>({ kind: 'preparing' })
  const [round, setRound] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const sessionKey = session?.pubkey ?? null

  useEffect(() => {
    let live = true
    setState({ kind: 'preparing' })
    ;(async () => {
      const previous = recall(shop.canonical)?.draftId
      // Editing invalidates the old draft (§3). Best effort: an orphan simply expires.
      if (previous) void api.invalidate(previous)
      const secrets = newGiftSecrets(form.deliver, sessionKey)
      let sealed: string | undefined
      if (form.deliver === 'email') {
        const issuer = await api.issuerKey()
        // G4: ONLY ℓ is sealed to the issuer, bound to this stall, amount and address. R never
        // leaves this browser except in the guest's own return link (G-R3).
        sealed = seal(
          issuer,
          { stallPubkey: shop.pubkey, amountMinor: toMinorUnits(form.amount, safeDecimals(shop.record.issuanceCurrency)) ?? 0, recipient: form.email.trim().toLowerCase() },
          { linkSecret: secrets.linkSecret! },
        )
      }
      const req = draftRequest(form, {
        stallPubkey: shop.pubkey,
        stallHandle: shop.nip05,
        currency: shop.record.issuanceCurrency,
        terms: termsVersion(shop.record),
        decimals: safeDecimals(shop.record.issuanceCurrency),
        refundPubkey: secrets.refundPubkey,
        sealed,
        signedIn: sessionKey !== null,
      })
      // A signed-in buyer's draft rides the session cookie; nothing is signed per request.
      const draft = await api.createDraft(req)
      if (!draftMatches(draft, req) || isExpired(draft)) throw new ApiError('Something changed while we checked. Please review again.', 409)
      // Only the LIVE run's draft is kept. A superseded run (an edit, a re-render, React's double
      // effect in development) still resolves, and keeping its draft would overwrite the guest's
      // refund key with one for a draft nobody pays: the paid gift's return link would be lost.
      if (!live) {
        void api.invalidate(draft.draftId)
        return
      }
      keep(shop.canonical, { form, draftId: draft.draftId, refundSecret: secrets.refundSecret })
      setState({ kind: 'ready', draft, refundSecret: secrets.refundSecret })
    })().catch((e: unknown) => {
      if (!live) return
      const err = e instanceof ApiError ? e : new ApiError(COPY.unreachable, 0)
      const message = err.code === CODES.termsChanged ? COPY.termsChanged(shop.name) : err.message
      setState({ kind: 'error', message, retry: err.status === 0 || err.status >= 500 || err.code === CODES.termsChanged })
    })
    return () => {
      live = false
    }
    // session object identity changes on every render of App; the key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop, form, sessionKey, round])

  const pay = async (draft: Draft) => {
    // Never charge an expired draft: check again first (§Edge cases).
    if (isExpired(draft)) {
      setNotice(COPY[CODES.expired])
      setRound((n) => n + 1)
      return
    }
    setState({ kind: 'paying', draft, refundSecret: state.kind === 'ready' ? state.refundSecret : undefined })
    try {
      // G15: a guest's return link goes to their email before Stripe, so a lost tab can't lose it.
      const refund = state.kind === 'ready' ? state.refundSecret : undefined
      const link = refund && WALLET_ORIGIN ? returnLink(WALLET_ORIGIN, refund) : undefined
      const { checkoutUrl } = await api.pay(draft.draftId, link)
      window.location.assign(checkoutUrl)
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(COPY.unreachable, 0)
      if (err.code === CODES.expired || err.code === CODES.invalidated || err.code === CODES.termsChanged) {
        setNotice(err.code === CODES.termsChanged ? COPY.termsChanged(shop.name) : COPY[CODES.expired])
        setRound((n) => n + 1)
        return
      }
      setState({ kind: 'error', message: err.message, retry: true })
    }
  }

  if (state.kind === 'preparing') return <Centered>Checking everything with {shop.name}…</Centered>
  if (state.kind === 'error')
    return (
      <Screen>
        <h1 className="mb-4 mt-4 text-title font-semibold">Review</h1>
        <Alert>{state.message}</Alert>
        <div className="mt-4 flex gap-3">
          {state.retry && <Button onClick={() => setRound((n) => n + 1)}>Try again</Button>}
          <Button variant="secondary" onClick={() => goForm()}>
            Edit
          </Button>
        </div>
      </Screen>
    )

  const draft = state.draft
  const validity = shop.record.voucherValidityDays
  const deadline = claimDeadline(Date.now(), validity, draft.delivery.claimWindowDays)
  const expiry = validity ? day(new Date(Date.now() + validity * 86_400_000)) : 'no expiry'
  // G17 (C): a gift taken back keeps the voucher's original expiry, so say what that leaves.
  const keeps = validity ? ` It keeps its original expiry, so you'd have until ${expiry} to spend it.` : " It doesn't expire."

  return (
    <Screen>
      <h1 className="mb-4 mt-4 text-title font-semibold">Check your gift</h1>
      {notice && <p className="mb-3 text-sm text-mono-500">{notice}</p>}

      <Section title="Voucher" onEdit={() => goForm('amount')}>
        <div className="mb-2 flex items-center gap-3">
          <Avatar src={shop.branding.picture} name={shop.name} />
          <div>
            <p className="font-medium">{shop.name}</p>
            <p className="text-xs text-mono-500">{displayHandle(shop.nip05)}</p>
          </div>
        </div>
        <p className="text-title font-semibold" data-testid="review-amount">
          {money(draft.amountMinor, draft.currency)}
        </p>
        <p className="text-sm text-mono-500">Spend it at {shop.name}. Voucher expiry: {expiry}.</p>
      </Section>

      <Section title="Recipient" onEdit={() => goForm('deliver')}>
        {draft.delivery.kind === 'handle' && draft.delivery.recipientPubkey && (
          <div data-testid="review-recipient">
            <p className="font-medium">{displayHandle(normaliseRecipientHandle(form.handle) ?? '')}</p>
            <p className="text-xs text-mono-500">Check this is the right person. The gift goes to their wallet as it is now.</p>
            <p className="mt-1 text-sm text-mono-500" data-testid="review-take-back">
              If they don&apos;t take it by {day(deadline)}, you can take it back.{keeps}
            </p>
          </div>
        )}
        {draft.delivery.kind === 'email' && (
          <div data-testid="review-recipient">
            <p className="break-all text-title font-semibold">{draft.delivery.email}</p>
            <p className="mt-1 text-sm text-mono-500">
              We&apos;ll email a link to claim it. They may need to check their spam folder.
            </p>
            <p className="mt-1 text-sm text-mono-500" data-testid="review-take-back">
              If it isn&apos;t claimed by {day(deadline)}, you can take it back.{keeps}
            </p>
          </div>
        )}
      </Section>

      <Section title="Message" onEdit={() => goForm('message')}>
        <p className="text-sm text-mono-500">{draft.from || form.from ? `From ${draft.from ?? form.from}` : 'Someone sent you a voucher'}</p>
        <p className="whitespace-pre-wrap">{draft.message ?? <span className="text-mono-500">No message</span>}</p>
      </Section>

      <Section title="Payment">
        <p>
          {money(draft.amountMinor, draft.currency)} charged to your card in {draft.currency.toUpperCase()}. Paid to {shop.name} via Stripe. Any
          currency conversion is your card issuer&apos;s.
        </p>
        <p className="mt-2 text-xs text-mono-500">Imani doesn&apos;t give refunds: refunds are {shop.name}&apos;s decision.</p>
        <p className="mt-2 text-xs text-mono-500">
          We&apos;ll email your receipt to {form.buyerEmail}, and tell you when the gift is claimed or if it isn&apos;t.
        </p>
      </Section>

      {/* A guest's refund key exists only in this browser (G3, G-R3): shown BEFORE paying, so a tab
          lost on the way to Stripe cannot cost the buyer their way to take the gift back. */}
      {state.refundSecret && WALLET_ORIGIN && (
        <Section title="Your return link">
          <p className="mb-2 text-sm text-mono-500">
            If the gift isn&apos;t claimed by {day(deadline)}, open it to take the gift back into a wallet. We&apos;ll email it to {form.buyerEmail}{' '}
            when you pay. Keep it private: it is yours, not the recipient&apos;s.
          </p>
          <a className="break-all text-sm underline" href={returnLink(WALLET_ORIGIN, state.refundSecret)} data-testid="review-return-link">
            Take the gift back
          </a>
        </Section>
      )}

      <Button size="lg" className="mt-2 w-full" disabled={state.kind === 'paying'} onClick={() => pay(draft)}>
        <CreditCard className="mr-2 h-5 w-5" aria-hidden /> {state.kind === 'paying' ? 'Taking you to the payment page…' : `Pay ${money(draft.amountMinor, draft.currency)}`}
      </Button>
    </Screen>
  )
}

function Section({ title, onEdit, children }: { title: string; onEdit?: () => void; children: React.ReactNode }) {
  return (
    <Panel className="mb-3 p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-mono-500">{title}</h2>
        {onEdit && (
          <button type="button" className="pressable flex items-center gap-1 text-sm underline" onClick={onEdit} aria-label={`Edit ${title.toLowerCase()}`}>
            <Pencil className="h-3 w-3" aria-hidden /> Edit
          </button>
        )}
      </div>
      {children}
    </Panel>
  )
}
