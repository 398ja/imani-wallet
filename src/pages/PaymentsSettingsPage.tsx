import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CreditCard, ExternalLink, Lock, TriangleAlert, Wallet } from 'lucide-react'

import { Button, Screen, BackLink, PageHeader, Centered, Switch } from '../components/ui'
import {
  connectStripe,
  disconnectStripe,
  fetchStripeStatus,
  refusalWords,
  startStripeOAuth,
  refreshStripe,
  type StripeAccountStatus,
  type StripeResult,
} from '../lib/stripeAccount'
import { connectPaypal, disconnectPaypal, fetchPaypalStatus, refreshPaypal } from '../lib/paypalAccount'
import { chooseCardAccount } from '../lib/cardAccount'
import { paypalEnabled, processorName, processorOf, type CardProcessor } from '../lib/cardProcessor'
import { reconcileCardOffer } from '../lib/cardOffer'
import { reconcileInstalmentOffer } from '../lib/instalmentOffer'
import {
  fetchStallInstalmentSettings,
  fetchStallInstalmentSummary,
  formatMoney,
  saveStallInstalmentSettings,
  type StallInstalmentSummary,
} from '../lib/instalments'
import { CARD_PAYMENTS_PLAN_NAME, cardPaymentsPlan, type CardPaymentsPlan } from '../lib/cardPaymentsAccess'
import { licenceStatus, type LicenceStatus } from '../lib/licenceStatus'
import { CardSalesSection, type CardSalesDeps } from '../components/CardSalesSection'
import { GiftingPageSection } from '../components/GiftingPageSection'
import { buildMerchantEvent, saveMerchant, type MerchantProfile } from '../lib/merchant'
import { getSigner } from '../lib/nap'
import { publish } from '../lib/relay'

/**
 * Taking card payments, from the stall's side.
 *
 * The screen that was missing. Every other piece of the card-purchase path
 * existed and none of it could run, because nothing published `acceptsCards`
 * and the Buy button is gated on it. This is where that flag comes from.
 *
 * ## Two things happen here, and only one is visible
 *
 * The visible one is connecting a Stripe account. The load-bearing one is
 * **republishing the stall record afterwards**, because that record is the only
 * channel a shopper has: `imani-merchant` is self-scoped, so nobody can ask it
 * whether somebody else takes cards.
 *
 * So every path ends in `reconcileCardOffer`. Connect, refresh, disconnect, and
 * the plain status read on mount — a stall whose Stripe was disabled while they
 * were away has their offer withdrawn the next time they look, without doing
 * anything.
 *
 * ## What a merchant is told, and why it is blunt
 *
 * With direct charges the stall is merchant of record. Disputes land on them,
 * and Stripe commonly holds a rolling reserve against stored value. "Get paid
 * upfront" is the whole pitch and a reserve claws part of it back, so a
 * merchant learns that here rather than from their first payout.
 *
 * ## Essentials and above
 *
 * Card payments are not on Starter. The plan is read on mount alongside Stripe
 * and goes into the same reconcile, so a Starter stall (or one whose plan
 * ended) that still publishes "I take cards" has the offer withdrawn here, and
 * one that never connected is shown the plan instead of Connect Stripe. A plan
 * that could not be checked changes nothing, as an unreachable Stripe does not.
 *
 * ## Stripe or PayPal
 *
 * A stall takes cards through ONE processor (payment-adapter ADR 0002). Before connecting, the
 * merchant picks Stripe or PayPal (offered when the build has `VITE_PAYPAL=on`); once connected,
 * the screen is about that account and the published offer names it (`cardProcessor`), so buyers
 * are sent to its checkout. To switch, the merchant stops taking card payments and connects the
 * other. Both read through the same status shape and the same `apply`, so every rule above holds
 * for either.
 */
export function PaymentsSettingsPage({
  merchant,
  onSaved,
  cardSales,
  status: planStatus = ownerLicenceStatus,
  paypal = paypalEnabled(),
}: {
  merchant: MerchantProfile
  onSaved: (next: MerchantProfile) => void
  /** Test seam for the card-sales step (#298). */
  cardSales?: CardSalesDeps
  /** Injected by tests. The licence check otherwise. */
  status?: (pubkey: string) => Promise<LicenceStatus>
  /** Whether PayPal is offered (`VITE_PAYPAL=on`). Injected by tests. */
  paypal?: boolean
}) {
  // A stall already on PayPal is read through PayPal even in a build that no longer offers it, so
  // its offer is never reconciled against a Stripe account it does not have (and withdrawn). The
  // flag only decides whether a stall may CHOOSE PayPal.
  const readsPaypal = paypal || processorOf(merchant) === 'paypal'
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState<StripeAccountStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [plan, setPlan] = useState<CardPaymentsPlan>('unknown')
  /** `OAUTH_DISABLED` hides the route rather than showing an error. */
  const [oauthDisabled, setOauthDisabled] = useState(false)
  /** Turning monthly payments on: the disclosure is open and waiting for the terms checkbox. */
  const [offeringMonthly, setOfferingMonthly] = useState(false)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [summary, setSummary] = useState<StallInstalmentSummary | null>(null)
  /** The plan as last read, for `apply` without making it a new function per read. */
  const planRef = useRef<CardPaymentsPlan>('unknown')
  /**
   * Which processor this screen is about: the connected one, else the one the record names, else
   * the merchant's pick before connecting. A ref beside the state so `apply` reads it current.
   */
  const [processor, setProcessorState] = useState<CardProcessor>(() => (readsPaypal ? processorOf(merchant) : 'stripe'))
  const processorRef = useRef<CardProcessor>(processor)
  const setProcessor = useCallback((next: CardProcessor) => {
    processorRef.current = next
    setProcessorState(next)
  }, [])
  const name = processorName(processor)

  /**
   * Read the plan again. On mount and on EVERY action, so a merchant who upgrades in the
   * subscription site and comes back is unlocked by Check again, not by a reload. Bounded: a
   * licence check that never settles (an IndexedDB blocked by another tab) must not hold the page
   * on Loading, so after `PLAN_CHECK_TIMEOUT_MS` it is `unknown`, which changes nothing.
   */
  const readPlan = useCallback(async () => {
    const licence = await withTimeout(planStatus(merchant.pubkey).catch(() => null), PLAN_CHECK_TIMEOUT_MS)
    planRef.current = cardPaymentsPlan(licence)
    setPlan(planRef.current)
  }, [planStatus, merchant.pubkey])

  /**
   * The current record, readable without re-running anything.
   *
   * `apply` publishes and then hands a NEW record up through `onSaved`. Reading
   * `merchant` from a closure meant the second action of a session compared
   * against the record as it was on mount: connect then disconnect would find
   * `acceptsCards` still false, decide nothing had changed, and leave a stall
   * publicly offering cards it had just switched off.
   *
   * A ref because the value must be current without making `apply` a new
   * function on every prop change — which would re-run the mount effect and
   * re-read Stripe each time we publish.
   */
  const current = useRef(merchant)
  useEffect(() => {
    current.current = merchant
  }, [merchant])

  /**
   * Take an answer from the service and make the world agree with it.
   *
   * The republish is the point. Without it this screen would change a stall's
   * Stripe account and leave every shopper looking at a stale record — which is
   * exactly the state the whole feature was stuck in before this page existed.
   */
  const apply = useCallback(
    async (result: StripeResult) => {
      if (result.kind !== 'ok') {
        setError(refusalWords(result))
        // A failed read must not withdraw a working offer, so nothing is
        // republished here. Same rule as an unreachable gateway when confirming
        // issuance: unknown changes nothing.
        return
      }

      setError(null)
      setStatus(result.status)

      const change = reconcileCardOffer(
        current.current,
        {
          chargesEnabled: result.status.chargesEnabled,
          defaultCurrency: result.status.defaultCurrency,
          processor: processorRef.current,
        },
        planRef.current,
      )

      // Composed AFTER the card reconcile, on its result, so one publish covers both: a stall
      // whose cards were just withdrawn loses monthly payments in the same record. A PayPal
      // status never says eligible, so a PayPal stall never keeps the offer.
      const afterCards = change.kind === 'republish' ? change.merchant : current.current
      const monthly = reconcileInstalmentOffer(afterCards, {
        instalmentsEligible: processorRef.current === 'stripe' && result.status.instalmentsEligible === true,
      })

      if (change.kind === 'unchanged' && monthly.kind === 'unchanged') {
        // The offer survives this read. A stall that switched on before the switch was enforced has
        // the published offer but no saved one, so every plan its buyers start would be refused. Its
        // consent was given (disclosure and terms), so carry it over, signed here by the stall. Only
        // when it NEVER saved one (no intervals: a saved row always has one): a stall that switched
        // off here, whose publish then failed, must stay off. An unreadable answer changes nothing.
        if (afterCards.acceptsInstalments === true) {
          void fetchStallInstalmentSettings(afterCards.pubkey).then((saved) => {
            const neverSaved = saved !== null && !saved.enabled && saved.intervals.length === 0
            if (neverSaved && current.current.acceptsInstalments === true) {
              void saveStallInstalmentSettings({ enabled: true })
            }
          })
        }
        return
      }
      const next = monthly.kind === 'republish' ? monthly.merchant : afterCards
      // Withdrawn here too, where it is enforced, so a direct call cannot start a plan the screen
      // just took away. Best effort: the published record is what this read is about.
      if (current.current.acceptsInstalments === true && next.acceptsInstalments !== true) {
        void saveStallInstalmentSettings({ enabled: false })
      }

      await publishRecord(
        next,
        change.kind === 'republish'
          ? next.acceptsCards === true
            ? 'Shoppers can now buy your vouchers by card.'
            : `Card payments are off: ${change.reason}.`
          : `Monthly payments are off: ${monthly.kind === 'republish' ? monthly.reason : ''}.`,
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onSaved],
  )

  /**
   * Save locally, sign and publish one stall record. Shared by the reconcile and by the stall's
   * own monthly payments switch, so both follow exactly the same order.
   */
  async function publishRecord(next: MerchantProfile, sentNote: string) {
    // Local first. Everything after this can fail without losing the change,
    // exactly as MerchantEditPage does.
    saveMerchant(next)
    current.current = next
    onSaved(next)

    try {
      const signed = await getSigner().signEvent(buildMerchantEvent(next))
      // Stamp what we published BEFORE the publish can fail, or a later read
      // of an older event looks newer and reverts this on screen.
      const published = { ...next, eventAt: signed.created_at }
      saveMerchant(published)
      current.current = published
      onSaved(published)

      const { ok } = await publish(signed)
      setNote(ok === 0 ? 'Saved on this device, but not sent yet. Shoppers may not see this for a while.' : sentNote)
    } catch {
      // `getSigner()` throws on a locked session, and this used to escape
      // `act()` and leave every button disabled with no explanation. The
      // change is saved locally either way, so this reports rather than
      // reverts.
      setNote('Saved on this device, but it could not be published. Shoppers may not see this yet.')
    }
  }

  /**
   * The stall's explicit opt-in (after the disclosure and terms) or opt-out.
   *
   * Saved to payment-adapter FIRST, because that is the switch plan start enforces; the published
   * record only shows or hides "Pay monthly". Turning on stops if the save fails, so the tab is
   * never shown for plans that would be refused. Turning off publishes regardless (hiding the tab
   * is still right) and says the save must be retried, since plans could otherwise still start.
   */
  const setMonthly = async (on: boolean) => {
    setBusy(true)
    setNote(null)
    try {
      const saved = await saveStallInstalmentSettings({ enabled: on })
      if (saved.kind !== 'ok' && on) {
        setError(saved.reason)
        return
      }
      await publishRecord(
        { ...current.current, acceptsInstalments: on },
        on ? 'Shoppers can now pay you monthly.' : 'Monthly payments are off. Plans already running carry on.',
      )
      if (saved.kind !== 'ok') {
        setError(`Monthly payments are hidden from shoppers, but could not be switched off everywhere. ${saved.reason}`)
      }
      setOfferingMonthly(false)
      setTermsAccepted(false)
    } finally {
      setBusy(false)
    }
  }

  /** "I already have a Stripe account": off to Stripe's consent page. */
  const startOAuth = async () => {
    setBusy(true)
    setNote(null)
    try {
      const result = await startStripeOAuth()
      if (result.kind === 'ok') {
        window.location.href = result.authorizeUrl
        return
      }
      if (result.kind === 'refused' && result.code === 'OAUTH_DISABLED') {
        // Not an error: this route simply is not offered here.
        setOauthDisabled(true)
        return
      }
      setError(refusalWords(result))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (merchant.acceptsInstalments !== true) return
    let cancelled = false
    void fetchStallInstalmentSummary(merchant.pubkey).then((result) => {
      if (!cancelled && result.kind === 'ok') setSummary(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [merchant.acceptsInstalments, merchant.pubkey])

  useEffect(() => {
    // On mount, and after Stripe redirects back. `refresh` re-reads Stripe
    // itself, so a merchant returning from onboarding sees the truth rather
    // than a mirror that has not caught up.
    const returningFrom: CardProcessor | null =
      params.get('stripe') !== null ? 'stripe' : readsPaypal && params.get('paypal') !== null ? 'paypal' : null
    const load = async () => {
      // The plan and the account(s) together, so the first reconcile already knows both. A failed
      // plan check is `unknown`, which changes nothing. Coming back from onboarding re-reads that
      // processor itself, so the merchant sees the truth rather than a lagging read.
      const [stripe, paypalRead] = await Promise.all([
        returningFrom === 'stripe' ? refreshStripe() : fetchStripeStatus(),
        readsPaypal ? (returningFrom === 'paypal' ? refreshPaypal() : fetchPaypalStatus()) : Promise.resolve(undefined),
        readPlan(),
      ])
      const chosen = readsPaypal
        ? chooseCardAccount({ stripe, paypal: paypalRead }, returningFrom ?? processorOf(current.current))
        : { processor: 'stripe' as const, result: stripe }
      setProcessor(chosen.processor)
      await apply(chosen.result)
      if (returningFrom) {
        // Drop the marker so a refresh of this page is an ordinary visit.
        params.delete(returningFrom)
        setParams(params, { replace: true })
      }
    }
    void load()
    // Deliberately once. Re-reading Stripe every time we publish a record would
    // be a loop, and `apply` now reads the live record through a ref rather
    // than a closure, so nothing here goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (fn: () => Promise<StripeResult>, redirect: boolean) => {
    setBusy(true)
    setNote(null)
    try {
      const [result] = await Promise.all([fn(), readPlan()])
      await apply(result)

      if (redirect && result.kind === 'ok') {
        if (result.status.onboardingUrl) {
          // A full navigation: Stripe hosts this, and identity documents and bank
          // details never touch this app.
          window.location.href = result.status.onboardingUrl
          return
        }

        // NOTHING HAPPENING IS NOT AN OPTION. Without this branch a refused or
        // absent setup link left the tap with no navigation, no message and no
        // console line — the worst failure a button can have, because there is
        // nothing to search for. Observed against stripe-mock, whose fixture URL
        // is on `*.stripe.me`: the allowlist correctly refused it and said so to
        // nobody.
        //
        // The reason travels on the status, set by the same predicate that did
        // the refusing, so this can never describe a different rule than the one
        // applied. When Stripe simply had no more to ask, say that instead of
        // inventing a failure.
        setError(
          result.status.onboardingUrlRejected ??
            `${processorName(processorRef.current)} did not send a setup link. Try Check again in a moment.`,
        )
      }
    } finally {
      // `finally`, because a throw here used to leave every button disabled
      // with nothing on screen explaining why.
      setBusy(false)
    }
  }

  /** G1 (#410): publish the gifting-page indexing opt-in with the rest of the stall record. */
  const toggleIndexing = useCallback(
    async (indexable: boolean) => {
      const next: MerchantProfile = { ...current.current, giftingIndexable: indexable }
      saveMerchant(next)
      current.current = next
      onSaved(next)
      try {
        const signed = await getSigner().signEvent(buildMerchantEvent(next))
        const published = { ...next, eventAt: signed.created_at }
        saveMerchant(published)
        current.current = published
        onSaved(published)
        const { ok } = await publish(signed)
        setNote(ok === 0 ? 'Saved on this device, but not sent yet.' : indexable ? 'Search engines may now list your gifting page.' : 'Your gifting page is hidden from search engines.')
      } catch {
        setNote('Saved on this device, but it could not be published.')
      }
    },
    [onSaved],
  )

  if (status === null && error === null) return <Centered>Loading…</Centered>

  const connected = status !== null && status.status !== 'not_connected'
  const live = status?.chargesEnabled === true
  const notInPlan = plan === 'not-included'
  /**
   * Whether shoppers can actually buy by card: Stripe live AND the offer is (or will be) published.
   * An unknown plan publishes nothing new, so it is offering only if the record already says so.
   */
  const offering = live && (plan === 'included' || (plan === 'unknown' && merchant.acceptsCards === true))
  const planUnchecked = live && plan === 'unknown' && !offering
  const currencyMismatch =
    live &&
    status?.defaultCurrency !== undefined &&
    status.defaultCurrency.toLowerCase() !== merchant.issuanceCurrency.toLowerCase()
  const stripe = processor === 'stripe'
  const oauth = stripe && status?.connectionType === 'OAUTH'
  const eligible = stripe && status?.instalmentsEligible === true
  const monthlyOn = merchant.acceptsInstalments === true
  // Needs the published card offer too: `reconcileInstalmentOffer` withdraws monthly payments from a
  // stall without `acceptsCards` (or with sales closed), so an opt-in there would not stick.
  const cardsOffered = merchant.acceptsCards === true && merchant.salesClosed !== true
  const canOfferMonthly = eligible && live && !currencyMismatch && cardsOffered
  const plansRunning = stripe && status?.activePlans === true

  // Only once Stripe has ANSWERED not connected. A failed Stripe read (status null) shows its error
  // on the ordinary screen rather than an upgrade prompt over a stall that may be connected.
  if (notInPlan && status !== null && !connected) {
    return (
      <Screen>
        <BackLink to="/settings" label="Settings" />
        <PageHeader title="Card payments" />
        {/* Kept on the locked screen: a Starter stall that just disconnected lands here, and must
            still be told whether its withdrawal reached the relays. */}
        {error && (
          <p className="expand-row mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </p>
        )}
        {note && (
          <p data-testid="card-payments-note" className="expand-row mb-4 rounded-xl bg-mono-100 px-4 py-3 text-sm dark:bg-mono-900">
            {note}
          </p>
        )}
        <LockedCardPayments busy={busy} name={name} onCheckAgain={() => act(processor === 'paypal' ? fetchPaypalStatus : fetchStripeStatus, false)} />
      </Screen>
    )
  }

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Card payments" />

      <p className="mb-6 text-[15px] leading-relaxed text-mono-500">
        Let shoppers buy your vouchers by card. You are paid directly by {name},
        into your own account.
      </p>

      {error && (
        <p className="expand-row mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}
      {note && (
        <p className="expand-row mb-4 rounded-xl bg-mono-100 px-4 py-3 text-sm dark:bg-mono-900">
          {note}
        </p>
      )}

      {/* Connected on a plan that does not include cards: Starter, or a plan that ended. The offer
          is withdrawn by the reconcile; this says why, and leaves Disconnect where it was. */}
      {notInPlan && (
        <div data-testid="card-payments-not-in-plan" className="mb-6 flex gap-2 rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="text-sm leading-relaxed">
            Card payments are part of {CARD_PAYMENTS_PLAN_NAME} and above, so shoppers cannot buy your
            vouchers by card on your current plan. Vouchers you have already sold are not affected.{' '}
            <Link to="/settings/subscription" className="font-medium underline">
              See plans
            </Link>
          </p>
        </div>
      )}

      {/* Stripe is live but the plan could not be checked, and no offer is published yet. Said,
          because otherwise the screen looks ready while shoppers see no Buy button. */}
      {planUnchecked && (
        <div data-testid="card-payments-plan-unchecked" className="mb-6 flex gap-2 rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="text-sm leading-relaxed">
            We could not check your plan, so shoppers cannot buy by card yet. Tap Check again when
            you are online.
          </p>
        </div>
      )}

      {/* The status card carries the answer to "where do I stand", so it leads
          with a sentence rather than a label and a value. Tracking is tightened
          on the heading because it is the largest text on the screen and reads
          loose at that size. */}
      <div className="mb-6 rounded-2xl border border-mono-200 p-4 dark:border-mono-800">
        <p className="text-[17px] font-semibold tracking-[-0.01em]">
          {offering
            ? 'Taking card payments'
            : live && notInPlan
              ? `${name} connected`
              : live
                ? 'Not offered yet'
                : connected
                  ? 'Not finished yet'
                  : 'Not connected'}
        </p>
        <p className="mt-1 text-[15px] leading-relaxed text-mono-500">
          {offering
            ? `Paid in ${status?.defaultCurrency?.toUpperCase() ?? 'your account currency'}.`
            : live && notInPlan
              ? 'Card payments are off on your current plan.'
              : live
                ? 'Waiting for your plan to be checked.'
                : connected
              ? `${name} still needs something from you before you can be paid.`
              : `Connect a ${name} account to start.`}
        </p>

        {/* Stripe's own words about what is outstanding. Shown rather than
            summarised: "requirements due" is a list a merchant can act on, and
            paraphrasing it would lose the one detail that unblocks them. */}
        {connected && !live && status !== null && status.requirementsDue.length > 0 && (
          <ul className="mt-3 list-disc pl-5 text-sm leading-relaxed text-mono-500">
            {status.requirementsDue.map((item) => (
              <li key={item}>{item.replace(/_/g, ' ')}</li>
            ))}
          </ul>
        )}
      </div>

      {/* The mismatch that would otherwise be found by a customer's failed
          payment. imani-woo ADR 0005: a coupon cannot split across currencies,
          so a session priced in one and a coupon issued in another cannot both
          be right. Card payments stay off until they agree.

          Amber and this exact shape because TerminalsPage says a consequence
          the same way — two warnings in one app that looked different would
          read as two systems. */}
      {currencyMismatch && (
        <div className="mb-6 flex gap-2 rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="text-sm leading-relaxed">
            Your vouchers are in {merchant.issuanceCurrency.toUpperCase()} but your {name}{' '}
            account pays in {status?.defaultCurrency?.toUpperCase()}. Card payments stay off
            until these match. Change your voucher currency in Your business, or use a{' '}
            {name} account in {merchant.issuanceCurrency.toUpperCase()}.
          </p>
        </div>
      )}

      {/* #298: Stripe pays the stall; this lets Imani issue the voucher that was paid for. Shown
          once Stripe can charge, because before that there is nothing to issue. Beside Connect
          Stripe, so the two halves of "selling by card" read as one setup. */}
      {offering && !currencyMismatch && <CardSalesSection deps={cardSales} />}

      {/* #410: once shoppers can pay by card, the stall's own gifting page and its indexing opt-in. */}
      {offering && !currencyMismatch && <GiftingPageSection merchant={merchant} onToggleIndexing={toggleIndexing} />}

      {connected && stripe && !notInPlan && (
        <div className="mb-6">
          <p className="mb-3 text-[15px] leading-relaxed text-mono-500" data-testid="monthly-eligibility">
            {eligible ? (
              'Monthly payments are available.'
            ) : status?.instalmentsEligibilityKnown ? (
              <>
                Your Stripe account setup means monthly payments aren&rsquo;t available.{' '}
                <details className="inline">
                  <summary className="inline cursor-pointer underline">Why?</summary>
                  <span className="block">
                    On this account, Imani would be billed for Stripe&rsquo;s fees or for losses such as refunds and
                    disputes.
                  </span>
                </details>
              </>
            ) : (
              'We couldn’t check your account yet.'
            )}
          </p>

          <Switch
            label="Monthly payments"
            hint="Let customers pay you a set amount each month and get a voucher each time."
            checked={monthlyOn || offeringMonthly}
            disabled={busy || (!monthlyOn && !canOfferMonthly)}
            onChange={(on) => {
              if (on) {
                setOfferingMonthly(true)
              } else if (offeringMonthly && !monthlyOn) {
                setOfferingMonthly(false)
                setTermsAccepted(false)
              } else {
                void setMonthly(false)
              }
            }}
          />

          {offeringMonthly && !monthlyOn && (
            <div className="expand-row mt-3 rounded-xl bg-mono-100 p-4 text-sm leading-relaxed dark:bg-mono-900">
              <p className="mb-2">
                <strong>You pay Stripe&rsquo;s fees, not Imani.</strong> Each monthly payment costs about 1.5% + 20p
                to process, plus 0.7% for recurring billing. On a £40 payment that is roughly £1.08 (2.7%). Small
                payments cost proportionally more, so the minimum is £20.
              </p>
              <p className="mb-2">
                <strong>Refunds and disputes are yours.</strong> Payments go straight to your Stripe account. If a
                customer asks for a refund or disputes a payment, it comes from your balance. Stripe may also hold a
                reserve.
              </p>
              <p className="mb-3">
                <strong>A customer can stop at any time.</strong> Monthly payments are a convenience, not a contract.
                Vouchers already issued stay valid.
              </p>
              <label className="mb-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                />
                <span>I&rsquo;ve read and accept the monthly payments terms.</span>
              </label>
              <Button size="sm" disabled={busy || !termsAccepted} onClick={() => setMonthly(true)}>
                Turn on monthly payments
              </Button>
            </div>
          )}

          {monthlyOn && summary !== null && (
            <p className="mt-3 text-[15px] leading-relaxed text-mono-500">
              {summary.activePlans} {summary.activePlans === 1 ? 'person pays' : 'people pay'} you monthly
              {summary.monthlyTotals.length > 0 &&
                `, ${summary.monthlyTotals.map((t) => formatMoney(t.amountMinor, t.currency)).join(' + ')} a month`}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3">
        {/* The choice, before connecting only: a connected stall switches by stopping first, so
            the published offer never names an account that is not set up. */}
        {paypal && !connected && !notInPlan && (
          <fieldset data-testid="card-processor-choice" className="mb-1 grid grid-cols-2 gap-2" disabled={busy}>
            <legend className="mb-2 text-sm font-medium">Take cards through</legend>
            {(['stripe', 'paypal'] as const).map((p) => (
              <label
                key={p}
                className={`pressable flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-[15px] ${processor === p ? 'border-mono-900 dark:border-mono-50' : 'border-mono-200 dark:border-mono-800'}`}
              >
                <input
                  type="radio"
                  name="card-processor"
                  className="sr-only"
                  checked={processor === p}
                  onChange={() => {
                    setProcessor(p)
                    setError(null)
                    setNote(null)
                  }}
                />
                {p === 'paypal' ? <Wallet className="h-4 w-4" aria-hidden /> : <CreditCard className="h-4 w-4" aria-hidden />}
                {processorName(p)}
              </label>
            ))}
          </fieldset>
        )}

        {/* Stripe: two routes (monthly payments spec, "Connect: two routes"). The stall's own
            account first, unless the deployment has not configured OAuth. */}
        {!connected && !notInPlan && stripe && !oauthDisabled && (
          <Button size="lg" disabled={busy} onClick={startOAuth}>
            <CreditCard className="mr-2 h-5 w-5" aria-hidden /> I already have a Stripe account
          </Button>
        )}

        {!connected && !notInPlan && (
          <Button
            size="lg"
            variant={stripe && !oauthDisabled ? 'outline' : undefined}
            disabled={busy}
            onClick={() => act(processor === 'paypal' ? connectPaypal : connectStripe, true)}
          >
            {stripe && !oauthDisabled ? (
              'Create a Stripe account'
            ) : (
              <>
                <CreditCard className="mr-2 h-5 w-5" aria-hidden /> Connect {name}
              </>
            )}
          </Button>
        )}

        {/* An account the stall already owns is finished in its own Dashboard, not through an
            onboarding link Stripe may not even issue for it. */}
        {connected && !live && !notInPlan && oauth && (
          <a
            href="https://dashboard.stripe.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-mono-900 px-5 font-medium text-mono-50 dark:bg-mono-50 dark:text-mono-900"
          >
            <ExternalLink className="mr-2 h-5 w-5" aria-hidden /> Open Stripe
          </a>
        )}

        {connected && !live && !notInPlan && !oauth && (
          <Button size="lg" disabled={busy} onClick={() => act(processor === 'paypal' ? connectPaypal : connectStripe, true)}>
            <ExternalLink className="mr-2 h-5 w-5" aria-hidden /> Finish setting up
          </Button>
        )}

        {connected && (
          <Button
            size="lg"
            variant="outline"
            disabled={busy}
            onClick={() => act(processor === 'paypal' ? refreshPaypal : refreshStripe, false)}
          >
            Check again
          </Button>
        )}

        {connected && !confirming && (
          <Button
            size="lg"
            variant="outline"
            disabled={busy || plansRunning}
            aria-describedby={plansRunning ? 'stop-blocked-reason' : undefined}
            onClick={() => setConfirming(true)}
          >
            Stop taking card payments
          </Button>
        )}
        {connected && plansRunning && (
          <p id="stop-blocked-reason" className="text-sm leading-relaxed text-mono-500">
            You have monthly payments running. Ask those customers to stop them, or stop them in Stripe, first.
          </p>
        )}
      </div>

      {/* Inline, not `window.confirm`. A native dialog is the one piece of UI
          this app cannot style, cannot animate, and cannot make legible in dark
          mode — and it steals the whole window for a question about one button.
          TerminalsPage already asks its destructive question this way, so this
          is the app's answer rather than a new one.

          Keeping it comes FIRST and is the plain button: the destructive option
          should never be where a thumb lands by habit. */}
      {confirming && (
        <div className="expand-row mt-3 rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
          <div className="flex gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p className="text-sm leading-relaxed">
              Shoppers will stop seeing a Buy button straight away. Vouchers you
              have already sold are not affected. Imani stops offering card payments for you.
              {stripe && (
                <>
                  {' '}If you want to connect a different Stripe account, stop first, then connect again.
                  Your earlier Stripe account stays in your Stripe login. Choose I already have a
                  Stripe account to use it again.
                  {oauth && ' You can also remove Imani in Stripe, under connected apps.'}
                </>
              )}
            </p>
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Keep taking payments
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setConfirming(false)
                await act(processor === 'paypal' ? disconnectPaypal : disconnectStripe, false)
              }}
            >
              Stop
            </Button>
          </div>
        </div>
      )}

      {/* Said before they connect, not after their first payout. With direct
          charges the stall is merchant of record, which is what keeps their
          money out of an Imani balance — and it is also what puts disputes and
          reserves on them. */}
      <div className="mt-8 text-[15px] leading-relaxed text-mono-500">
        <p className="mb-2 font-medium text-mono-900 dark:text-mono-50">Worth knowing</p>
        <p className="mb-2">
          You are paid directly, so the money is yours from the moment a shopper
          pays. Imani never holds it.
        </p>
        <p className="mb-2">
          This is your own {name} account. {name}, not Imani, handles questions about payouts and verification.
        </p>
        <p>
          That also means disputes are yours to answer, and {name} may hold back
          a percentage of new sales for a period before paying out. That is
          normal for vouchers, because you are promising something for later.
        </p>
      </div>
    </Screen>
  )
}

/** Stable, so the mount effect's plan read is the same function on every render. */
const ownerLicenceStatus = (pubkey: string) => licenceStatus({ pubkey })

/** How long the plan check may take before the page goes on without it (as `unknown`). */
export const PLAN_CHECK_TIMEOUT_MS = 5_000

function withTimeout<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/**
 * Starter, never connected: what card payments are and which plan has them, instead of Connect.
 * Check again re-reads the plan, so a merchant back from upgrading is unlocked without a reload.
 */
function LockedCardPayments({ busy, name, onCheckAgain }: { busy: boolean; name: string; onCheckAgain: () => void }) {
  return (
    <div data-testid="card-payments-locked" className="flex flex-col items-center px-2 pt-6 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-mono-100 dark:bg-mono-900">
        <Lock className="h-8 w-8 text-mono-500" aria-hidden />
      </div>
      <p className="text-lg font-semibold text-mono-900 dark:text-mono-50">Sell your vouchers by card</p>
      <p className="mt-2 text-sm leading-relaxed text-mono-500">
        Shoppers buy your vouchers by card and you are paid directly by {name}, into your own account.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-mono-500">
        Card payments are part of {CARD_PAYMENTS_PLAN_NAME} and above. Upgrade to connect {name}.
      </p>
      <Link to="/settings/subscription" className="mt-6 block w-full">
        <Button className="w-full">See plans</Button>
      </Link>
      <Button className="mt-3 w-full" variant="outline" disabled={busy} onClick={onCheckAgain}>
        Check again
      </Button>
    </div>
  )
}
