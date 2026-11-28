import { useEffect, useId, useState } from 'react'
import { useStallStatus } from '../hooks/useStallStatus'
import { closedMessage } from '../lib/merchantStatus'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CreditCard } from 'lucide-react'

import { Button, Screen, BackLink, Centered, buttonClasses } from '../components/ui'
import { startPurchase } from '../lib/purchase'
import { GUEST_BUY_ELSEWHERE, rememberPurchase } from '../lib/pendingPurchase'
import { giftingOrigin, giftingPageUrl } from '../lib/giftingPage'
import { useIdentity } from '../lib/identity'
import { cardSalesReadiness } from '../lib/cardSalesEnrolment'
import { cardSalesReason, type CardSalesReadiness } from '../lib/merchantActions'
import { rememberAfterLogin } from '../lib/afterLogin'
import { fetchMerchantRecord } from '../lib/merchant'
import { processorOf, type CardProcessor } from '../lib/cardProcessor'
import {
  fetchStallInstalmentSettings,
  isMonthlyOnly,
  startInstalments,
  type PlanInterval,
  type PlanTerm,
  type StartRefusal,
} from '../lib/instalments'
import { MonthlyPaymentForm } from '../components/MonthlyPaymentForm'


/**
 * Buying a stall's coupon with a card.
 *
 * The customer picks an amount, taps once, and leaves for Stripe. Everything
 * that could refuse the purchase — the stall having no connected account, cards
 * not being enabled yet, no currency configured — is decided before they get
 * there, because a card form that fails after somebody has typed their number
 * is the worst place to discover a configuration problem.
 *
 * ## Where the coupon goes
 *
 * The buyer's pubkey rides on the Checkout Session, so payment confirmation
 * already names the recipient and no second lookup is needed. It is passed in
 * rather than read from a session, because this screen renders in both route
 * trees: the authenticated one knows who is buying, and the public one has
 * nobody to ask.
 *
 * A visitor with no wallet is sent to the stall's gifting page (#410), which
 * takes guests: it delivers by handle or emailed Cashlink. This page still
 * never starts a guest checkout, and payment-adapter still refuses one here.
 *
 * ## Amounts
 *
 * Typed rather than chosen from a list. A stall sells whatever it sells, and a
 * fixed ladder would be this screen guessing at a stall's prices from another
 * country.
 *
 * ## Stripe or PayPal
 *
 * The stall's public record names its processor (`cardProcessor`, Stripe when absent), and the
 * buyer is sent to that processor's checkout. Read again at the moment of paying, like the
 * open-for-business check, so a stall that switched while this screen was open is paid where it
 * now takes cards. An unreadable record is Stripe, as an old record is: each checkout refuses a
 * stall it cannot charge for, so the worst case is one refused tap and nothing charged.
 */
export function BuyPage({
  buyerPubkey = null,
  offersMonthly: offersMonthlyOverride,
}: {
  buyerPubkey?: string | null
  /** Test seam: whether the stall's public record offers Monthly payments. Read from the relay otherwise. */
  offersMonthly?: boolean
}) {
  /*
   * How often this stall lets buyers pay: its saved offer, the one payment-adapter enforces.
   * Monthly until it answers, and when it cannot be read or names nothing, which is what every
   * stall offered before weekly and yearly plans; payment-adapter refuses anything it does not
   * offer, so a stale answer costs one refused tap, never a wrong charge.
   */
  const [offeredIntervals, setOfferedIntervals] = useState<{ stall: string; intervals: PlanInterval[] } | null>(null)
  const { pubkey = '' } = useParams()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'one-off' | 'monthly'>('one-off')
  const [monthlyRefusal, setMonthlyRefusal] = useState<StartRefusal | null>(null)
  const [record, setRecord] = useState<{ stall: string; monthly: boolean; currency: string } | null>(null)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cardSales, setCardSales] = useState<CardSalesReadiness>('checking')
  // #434: a closed stall sells nothing by card, whatever Stripe says.
  const stall = useStallStatus(pubkey)
  const stallSells = stall.status === 'open' && stall.sellsByCard
  const stallNote =
    stall.status === 'loading'
      ? 'Checking this merchant is open…'
      : stall.status === 'open'
        ? stall.sellsByCard ? null : "Card payments aren't set up for this merchant"
        : closedMessage(stall.status === 'customer' ? 'unknown' : stall.status)
  const readinessId = useId()

  /*
   * #298: can the purchase issuer issue for this stall? A link straight here skips the stall
   * page's Buy gate, so this page asks too. Fails safe: no answer is "not ready", and a stall that
   * cannot issue is never sent to Checkout, because the card would be charged for nothing.
   */
  useEffect(() => {
    if (buyerPubkey === null) return
    let live = true
    cardSalesReadiness(pubkey)
      .catch((): 'not-ready' => 'not-ready')
      .then((ready) => {
        if (live) setCardSales(ready)
      })
    return () => {
      live = false
    }
  }, [pubkey, buyerPubkey])

  /*
   * Monthly payments: the "Pay monthly" tab is HIDDEN, not disabled, unless the stall's public
   * record says it offers them. A buyer should not see an option a stall never offered. Fails
   * closed: no record, or a slow one, means no tab.
   */
  useEffect(() => {
    if (offersMonthlyOverride !== undefined) return
    let live = true
    fetchMerchantRecord(pubkey)
      .catch(() => null)
      .then((m) => {
        if (live) setRecord({ stall: pubkey, monthly: m?.acceptsInstalments === true, currency: m?.issuanceCurrency ?? 'gbp' })
      })
    return () => {
      live = false
    }
  }, [pubkey, offersMonthlyOverride])
  useEffect(() => {
    let live = true
    fetchStallInstalmentSettings(pubkey)
      .catch(() => null)
      .then((offer) => {
        if (live && offer !== null && offer.enabled && offer.intervals.length > 0) {
          setOfferedIntervals({ stall: pubkey, intervals: offer.intervals })
        }
      })
    return () => {
      live = false
    }
  }, [pubkey])
  const offersMonthly =
    offersMonthlyOverride ?? (record !== null && record.stall === pubkey && record.monthly)
  const currency = record?.stall === pubkey ? record.currency : 'gbp'
  const showMonthly = offersMonthly && mode === 'monthly'
  const intervals: PlanInterval[] = offeredIntervals?.stall === pubkey ? offeredIntervals.intervals : ['month']
  const monthlyOnly = isMonthlyOnly(intervals)

  const minor = toMinorUnits(amount)
  /**
   * Only complain about what they have finished typing.
   *
   * "2" on the way to "25.00" is not an error, and a field that turns red under
   * the cursor teaches people to distrust the validation rather than the input.
   * So the message waits for something that cannot become valid by typing more.
   */
  const malformed = amount.trim() !== '' && minor === null && !/^\d*\.?\d{0,2}$/.test(amount.trim())

  const buy = async () => {
    if (minor === null) return
    setBusy(true)
    setError(null)

    // Asked again at the tap (#298): the answer on screen may be minutes old, and this is the
    // last moment nothing has been charged.
    // #434: and is the stall still open? A stall that closed since the page loaded is never sent
    // to Stripe.
    const now = await stall.recheck()
    if (now.status !== 'open' || !now.sellsByCard) {
      setBusy(false)
      setError(`${(closedMessage(now.status === 'customer' ? 'unknown' : now.status) ?? "Card payments aren't available").replace(/\.$/, '')}. Nothing was charged.`)
      return
    }
    const readiness = await cardSalesReadiness(pubkey).catch((): 'not-ready' => 'not-ready')
    if (readiness !== 'ready') {
      setCardSales(readiness)
      setBusy(false)
      setError(`${cardSalesReason(readiness).replace(/\.$/, '')}. Nothing was charged.`)
      return
    }

    // Remembered on THIS device so the return page can name the stall without
    // trusting anything Stripe puts in the URL. Before the call, so a slow
    // redirect cannot race it.
    rememberPurchase(pubkey)
    const processor: CardProcessor = processorOf(await fetchMerchantRecord(pubkey))
    const result = await startPurchase({
      stallPubkey: pubkey,
      amountMinor: minor,
      buyerPubkey,
      processor,
    })

    if (result.kind === 'ok') {
      // A full navigation, not a router push: Stripe is another origin, and
      // this hands the customer over rather than rendering anything of theirs.
      window.location.href = result.checkoutUrl
      return
    }

    setBusy(false)
    setError(result.reason)
  }

  /** Same checks as a one-off, at the tap, then the adapter decides the rest. */
  const startMonthly = async (amountMinor: number, term: PlanTerm, interval: PlanInterval = 'month') => {
    if (buyerPubkey === null) return
    setBusy(true)
    setMonthlyRefusal(null)
    const now = await stall.recheck()
    if (now.status !== 'open' || !now.sellsByCard) {
      setBusy(false)
      setMonthlyRefusal({ kind: 'other', reason: `${(closedMessage(now.status === 'customer' ? 'unknown' : now.status) ?? "Card payments aren't available").replace(/\.$/, '')}. Nothing was charged.` })
      return
    }
    const readiness = await cardSalesReadiness(pubkey).catch((): 'not-ready' => 'not-ready')
    if (readiness !== 'ready') {
      setCardSales(readiness)
      setBusy(false)
      return
    }
    // Remembered with its kind, so the return page uses the right words without trusting the URL.
    rememberPurchase(pubkey, 'monthly', interval)
    const result = await startInstalments({ stallPubkey: pubkey, buyerPubkey, amountMinor, term, interval })
    if (result.kind === 'ok') {
      window.location.href = result.checkoutUrl
      return
    }
    setBusy(false)
    // The stall changed how often it takes payments while this form was open: offer what it takes now.
    if (result.refusal.kind === 'interval-not-offered' && result.refusal.intervals.length > 0) {
      setOfferedIntervals({ stall: pubkey, intervals: result.refusal.intervals })
    }
    setMonthlyRefusal(result.refusal)
  }

  // Not on the monthly path: the amount and term live in MonthlyPaymentForm, and unmounting it for
  // the tap-time recheck would throw away what the buyer typed whenever the answer is a refusal.
  // The form takes `busy` and disables itself instead.
  if (busy && !showMonthly) return <Centered>Taking you to the payment page…</Centered>

  if (buyerPubkey === null) {
    return <GuestBuy pubkey={pubkey} offersMonthly={offersMonthly} monthlyOnly={monthlyOnly} />
  }

  return (
    <Screen>
      <BackLink to={`/merchants/${pubkey}`} label="Back" />

      {/* Tracking tightened at this size: a heading reads loose with the body
          tracking the system font ships by default. */}
      <h1 className="mb-2 text-title font-semibold">Buy a voucher</h1>
      <p className="mb-6 text-callout text-mono-500">
        {showMonthly
          ? monthlyOnly
            ? 'You pay this stall directly by card, once a month. A voucher arrives in your wallet with each payment.'
            : 'You pay this stall directly by card, a set amount each time. A voucher arrives in your wallet with each payment.'
          : 'You pay this stall directly by card. The voucher arrives in your wallet.'}
      </p>

      {offersMonthly && (
        <div role="tablist" aria-label="How to pay" className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-mono-100 p-1 dark:bg-mono-900">
          {(['one-off', 'monthly'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`pressable rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-100 ${
                mode === m ? 'bg-white shadow-sm dark:bg-mono-800' : 'text-mono-500'
              }`}
            >
              {m === 'one-off' ? 'One payment' : monthlyOnly ? 'Pay monthly' : 'Pay over time'}
            </button>
          ))}
        </div>
      )}

      {showMonthly ? (
        <MonthlyPaymentForm
          // No `key`: a narrowed offer (a refusal naming what the stall takes now) must keep the amount
          // the buyer typed. The form moves its own choice onto one the stall offers.
          currency={currency}
          intervals={intervals}
          unavailable={stallNote ?? (cardSales !== 'ready' ? cardSalesReason(cardSales) : null)}
          refusal={monthlyRefusal}
          busy={busy}
          onStart={startMonthly}
        />
      ) : (
        <>
          <label className="mb-2 block text-sm font-medium" htmlFor="amount">
            Amount
          </label>
          {/*
            `inputMode="decimal"` puts a number pad under a thumb without the
            spinners and scroll-to-change that `type="number"` brings.

            The focus ring is the app's own rather than the browser default, which
            differs per platform and would be the one control here that looks
            borrowed.
          */}
          <input
            id="amount"
            inputMode="decimal"
            autoComplete="off"
            className="mb-2 w-full rounded-xl border border-mono-200 bg-transparent px-4 py-3 text-lg tabular-nums outline-none transition-colors duration-100 ease-out placeholder:text-mono-400 focus:border-mono-400 dark:border-mono-800 dark:focus:border-mono-600"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="25.00"
            aria-describedby={malformed ? 'amount-hint' : undefined}
            aria-invalid={malformed || undefined}
          />

          {malformed && (
            <p id="amount-hint" className="mb-2 text-sm text-mono-500">
              Enter an amount like 25.00.
            </p>
          )}

          {error && (
            // `role="alert"`, like the shared `Alert`: it answers the tap the
            // customer just made, so it is announced rather than painted silently.
            <p role="alert" className="expand-row mb-4 mt-2 rounded-xl bg-red-50 px-4 py-3 text-sm leading-relaxed text-red-700 dark:bg-red-950/50 dark:text-red-300">
              {error}
            </p>
          )}

          {/* Disabled rather than hidden: an amount box with no button beside it
              reads as broken, and the reason it cannot be pressed is visible in the
              empty field. */}
          <Button
            size="lg"
            className="mt-4 w-full"
            disabled={minor === null || cardSales !== 'ready' || !stallSells || busy}
            aria-describedby={cardSales !== 'ready' || !stallSells ? readinessId : undefined}
            onClick={buy}
          >
            <CreditCard className="mr-2 h-5 w-5" aria-hidden /> Pay by card
          </Button>
          {/* The reason sits under the button it disables (#281), and is announced with it. */}
          {(stallNote || cardSales !== 'ready') && (
            <p id={readinessId} className="mt-2 text-center text-xs text-mono-600 dark:text-mono-400">
              {stallNote ?? (cardSales !== 'ready' ? cardSalesReason(cardSales) : null)}
            </p>
          )}
        </>
      )}

      {/* A text button, not a second heavy one. Cancelling is the quiet path
          and should not compete with the thing they came here to do. */}
      <button
        type="button"
        className="pressable mt-3 inline-block py-3 text-sm text-mono-500 underline"
        onClick={() => navigate(`/merchants/${pubkey}`)}
      >
        Cancel
      </button>
    </Screen>
  )
}

/**
 * A typed amount as minor units, or null when it is not one.
 *
 * Null rather than zero for anything unusable, so the button's disabled state
 * and the parse share one answer. Rejecting rather than rounding: a customer
 * typing "25.999" has made a mistake, and silently charging them 26.00 is a
 * worse response than not moving.
 */
function toMinorUnits(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const minor = Math.round(Number(trimmed) * 100)
  return Number.isFinite(minor) && minor > 0 ? minor : null
}

/** A visitor with no wallet: the stall's gifting page, or a wallet. */
function GuestBuy({ pubkey, offersMonthly, monthlyOnly }: { pubkey: string; offersMonthly: boolean; monthlyOnly: boolean }) {
  const navigate = useNavigate()
  const identity = useIdentity(pubkey)
  const gifting = giftingPageUrl(identity?.nip05)
  return (
    <Screen>
      <BackLink to={`/merchants/${pubkey}`} label="Back" />
      <h1 className="mb-2 text-title font-semibold">Buy a voucher</h1>
      <p className="mb-6 text-callout text-mono-500">{GUEST_BUY_ELSEWHERE}</p>
      {gifting && (
        <a href={gifting} className={`${buttonClasses('primary', 'lg')} mb-3 w-full`}>
          Buy on the gifting page
        </a>
      )}
      <Link to="/" className={`${buttonClasses(gifting ? 'secondary' : 'primary', 'lg')} w-full`}>
        Create a wallet
      </Link>
      {/* Regular payments need a wallet key to deliver a voucher to every time, so there is no
          guest path: log in, and come straight back here. */}
      {offersMonthly && (
        <button
          type="button"
          className="pressable mt-3 inline-block py-3 text-sm text-mono-500 underline"
          onClick={() => {
            rememberAfterLogin(`/buy/${pubkey}`)
            navigate('/login')
          }}
        >
          {monthlyOnly ? 'Log in to pay monthly' : 'Log in to pay over time'}
        </button>
      )}
      {!gifting && (
        <p className="mt-3 text-xs text-mono-500">
          {giftingOrigin()
            ? `This stall has no gifting page yet. Gifting lives at ${giftingOrigin()}.`
            : 'This stall has no gifting page yet.'}
        </p>
      )}
    </Screen>
  )
}
