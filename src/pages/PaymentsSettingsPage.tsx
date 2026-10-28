import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CreditCard, ExternalLink, TriangleAlert } from 'lucide-react'

import { Button, Screen, BackLink, PageHeader, Centered } from '../components/ui'
import {
  connectStripe,
  disconnectStripe,
  fetchStripeStatus,
  refreshStripe,
  type StripeAccountStatus,
  type StripeResult,
} from '../lib/stripeAccount'
import { reconcileCardOffer } from '../lib/cardOffer'
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
 */
export function PaymentsSettingsPage({
  merchant,
  onSaved,
  cardSales,
}: {
  merchant: MerchantProfile
  onSaved: (next: MerchantProfile) => void
  /** Test seam for the card-sales step (#298). */
  cardSales?: CardSalesDeps
}) {
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState<StripeAccountStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

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

      const change = reconcileCardOffer(current.current, {
        chargesEnabled: result.status.chargesEnabled,
        defaultCurrency: result.status.defaultCurrency,
      })

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
    const returning = params.get('stripe') !== null
    const load = async () => {
      await apply(returning ? await refreshStripe() : await fetchStripeStatus())
      if (returning) {
        // Drop the marker so a refresh of this page is an ordinary visit.
        params.delete('stripe')
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
      const result = await fn()
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
            'Stripe did not send a setup link. Try Check again in a moment.',
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
  const currencyMismatch =
    live &&
    status?.defaultCurrency !== undefined &&
    status.defaultCurrency.toLowerCase() !== merchant.issuanceCurrency.toLowerCase()

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Card payments" />

      <p className="mb-6 text-[15px] leading-relaxed text-mono-500">
        Let shoppers buy your vouchers by card. You are paid directly by Stripe,
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

      {/* The status card carries the answer to "where do I stand", so it leads
          with a sentence rather than a label and a value. Tracking is tightened
          on the heading because it is the largest text on the screen and reads
          loose at that size. */}
      <div className="mb-6 rounded-2xl border border-mono-200 p-4 dark:border-mono-800">
        <p className="text-[17px] font-semibold tracking-[-0.01em]">
          {live ? 'Taking card payments' : connected ? 'Not finished yet' : 'Not connected'}
        </p>
        <p className="mt-1 text-[15px] leading-relaxed text-mono-500">
          {live
            ? `Paid in ${status?.defaultCurrency?.toUpperCase() ?? 'your account currency'}.`
            : connected
              ? 'Stripe still needs something from you before you can be paid.'
              : 'Connect a Stripe account to start.'}
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
            Your vouchers are in {merchant.issuanceCurrency.toUpperCase()} but your Stripe
            account pays in {status?.defaultCurrency?.toUpperCase()}. Card payments stay off
            until these match. Change your voucher currency in Your business, or use a
            Stripe account in {merchant.issuanceCurrency.toUpperCase()}.
          </p>
        </div>
      )}

      {/* #298: Stripe pays the stall; this lets Imani issue the voucher that was paid for. Shown
          once Stripe can charge, because before that there is nothing to issue. Beside Connect
          Stripe, so the two halves of "selling by card" read as one setup. */}
      {live && !currencyMismatch && <CardSalesSection deps={cardSales} />}

      {/* #410: once shoppers can pay by card, the stall's own gifting page and its indexing opt-in. */}
      {live && !currencyMismatch && <GiftingPageSection merchant={merchant} onToggleIndexing={toggleIndexing} />}

      <div className="grid gap-3">
        {!connected && (
          <Button size="lg" disabled={busy} onClick={() => act(connectStripe, true)}>
            <CreditCard className="mr-2 h-5 w-5" aria-hidden /> Connect Stripe
          </Button>
        )}

        {connected && !live && (
          <Button size="lg" disabled={busy} onClick={() => act(connectStripe, true)}>
            <ExternalLink className="mr-2 h-5 w-5" aria-hidden /> Finish setting up
          </Button>
        )}

        {connected && (
          <Button
            size="lg"
            variant="outline"
            disabled={busy}
            onClick={() => act(refreshStripe, false)}
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
                await act(disconnectStripe, false)
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
          That also means disputes are yours to answer, and Stripe may hold back
          a percentage of new sales for a period before paying out. That is
          normal for vouchers, because you are promising something for later.
        </p>
      </div>
    </Screen>
  )
}
