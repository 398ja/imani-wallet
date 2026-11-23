import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CreditCard, ExternalLink, Lock, TriangleAlert, Wallet } from 'lucide-react'

import { Button, Screen, BackLink, PageHeader, Centered } from '../components/ui'
import {
  connectStripe,
  disconnectStripe,
  fetchStripeStatus,
  refreshStripe,
  type StripeAccountStatus,
  type StripeResult,
} from '../lib/stripeAccount'
import { connectPaypal, disconnectPaypal, fetchPaypalStatus, refreshPaypal } from '../lib/paypalAccount'
import { chooseCardAccount } from '../lib/cardAccount'
import { paypalEnabled, processorName, processorOf, type CardProcessor } from '../lib/cardProcessor'
import { reconcileCardOffer } from '../lib/cardOffer'
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
        setError(result.reason)
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

      if (change.kind === 'unchanged') return

      // Local first. Everything after this can fail without losing the change,
      // exactly as MerchantEditPage does.
      saveMerchant(change.merchant)
      current.current = change.merchant
      onSaved(change.merchant)

      try {
        const signed = await getSigner().signEvent(buildMerchantEvent(change.merchant))
        // Stamp what we published BEFORE the publish can fail, or a later read
        // of an older event looks newer and reverts this on screen.
        const published = { ...change.merchant, eventAt: signed.created_at }
        saveMerchant(published)
        current.current = published
        onSaved(published)

        const { ok } = await publish(signed)
        setNote(
          ok === 0
            ? 'Saved on this device, but not sent yet. Shoppers may not see this for a while.'
            : change.merchant.acceptsCards === true
              ? 'Shoppers can now buy your vouchers by card.'
              : `Card payments are off: ${change.reason}.`,
        )
      } catch {
        // `getSigner()` throws on a locked session, and this used to escape
        // `act()` and leave every button disabled with no explanation. The
        // change is saved locally either way, so this reports rather than
        // reverts.
        setNote('Saved on this device, but it could not be published. Shoppers may not see this yet.')
      }
    },
    [onSaved],
  )

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

        {!connected && !notInPlan && (
          <Button size="lg" disabled={busy} onClick={() => act(processor === 'paypal' ? connectPaypal : connectStripe, true)}>
            <CreditCard className="mr-2 h-5 w-5" aria-hidden /> Connect {name}
          </Button>
        )}

        {connected && !live && !notInPlan && (
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
          <Button size="lg" variant="outline" disabled={busy} onClick={() => setConfirming(true)}>
            Stop taking card payments
          </Button>
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
              have already sold are not affected.
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
