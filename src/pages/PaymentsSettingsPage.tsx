import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CreditCard, ExternalLink, ShieldAlert } from 'lucide-react'

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
import { buildMerchantEvent, saveMerchant, type MerchantProfile } from '../lib/merchant'
import { getSigner } from '../lib/nap'
import { publish } from '../lib/relay'

/**
 * Taking card payments, from the stall's side.
 *
 * The screen that was missing. Every other piece of the card-purchase path
 * existed — direct charges, the debt queue, the issuer, the buy page — and
 * none of it could ever run, because nothing published `acceptsCards` and the
 * Buy button is gated on it. This is where that flag comes from.
 *
 * ## Two things happen here, and only one is obvious
 *
 * The visible one is connecting a Stripe account. The load-bearing one is
 * **republishing the stall record afterwards**, because that record is the only
 * channel a shopper has: `imani-merchant` is self-scoped, so nobody can ask it
 * whether somebody else takes cards.
 *
 * So every path through this screen ends in `reconcileCardOffer`. Connect,
 * refresh, disconnect, and the plain status read on mount — a stall whose
 * Stripe was disabled while they were away has their offer withdrawn the next
 * time they look, without doing anything.
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
}: {
  merchant: MerchantProfile
  onSaved: (next: MerchantProfile) => void
}) {
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState<StripeAccountStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

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

      const change = reconcileCardOffer(merchant, {
        chargesEnabled: result.status.chargesEnabled,
        defaultCurrency: result.status.defaultCurrency,
      })

      if (change.kind === 'unchanged') return

      // Local first. Everything after this can fail without losing the change,
      // exactly as MerchantEditPage does.
      saveMerchant(change.merchant)
      onSaved(change.merchant)

      try {
        const signed = await getSigner().signEvent(buildMerchantEvent(change.merchant))
        // Stamp what we published BEFORE the publish can fail, or a later read
        // of an older event looks newer and reverts this on screen.
        const published = { ...change.merchant, eventAt: signed.created_at }
        saveMerchant(published)
        onSaved(published)

        const { ok } = await publish(signed)
        setNote(
          ok === 0
            ? 'Saved on this device, but no relay accepted it. Shoppers may not see this yet.'
            : change.merchant.acceptsCards === true
              ? 'Shoppers can now buy your vouchers by card.'
              : `Card payments are off: ${change.reason}.`,
        )
      } catch {
        setNote('Saved on this device, but it could not be published. Shoppers may not see this yet.')
      }
    },
    [merchant, onSaved],
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
    // Deliberately once. `apply` closes over the merchant record, and rerunning
    // this on every change would re-read Stripe each time we publish one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const act = async (fn: () => Promise<StripeResult>, redirect: boolean) => {
    setBusy(true)
    setNote(null)
    const result = await fn()
    await apply(result)
    setBusy(false)

    if (redirect && result.kind === 'ok' && result.status.onboardingUrl) {
      // A full navigation: Stripe hosts this, and identity documents and bank
      // details never touch this app.
      window.location.href = result.status.onboardingUrl
    }
  }

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

      <p className="mb-6 text-sm text-mono-500">
        Let shoppers buy your vouchers by card. You are paid directly by Stripe,
        into your own account.
      </p>

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {note && (
        <p className="mb-4 rounded-lg bg-mono-100 px-3 py-2 text-sm dark:bg-mono-800">{note}</p>
      )}

      <div className="mb-6 rounded-lg border border-mono-200 p-4 dark:border-mono-800">
        <p className="font-medium">
          {live ? 'Taking card payments' : connected ? 'Not finished yet' : 'Not connected'}
        </p>
        <p className="mt-1 text-sm text-mono-500">
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
          <ul className="mt-3 list-disc pl-5 text-sm text-mono-500">
            {status.requirementsDue.map((item) => (
              <li key={item}>{item.replace(/_/g, ' ')}</li>
            ))}
          </ul>
        )}
      </div>

      {/* The mismatch that would otherwise be found by a customer's failed
          payment. imani-woo ADR 0005: a coupon cannot split across currencies,
          so a session priced in one and a coupon issued in another cannot both
          be right. Card payments stay off until they agree. */}
      {currencyMismatch && (
        <div className="mb-6 flex gap-3 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
          <ShieldAlert className="h-5 w-5 shrink-0" />
          <p>
            Your vouchers are in {merchant.issuanceCurrency.toUpperCase()} but your Stripe
            account pays in {status?.defaultCurrency?.toUpperCase()}. Card payments stay off
            until these match. Change your voucher currency in Your business, or use a
            Stripe account in {merchant.issuanceCurrency.toUpperCase()}.
          </p>
        </div>
      )}

      <div className="grid gap-3">
        {!connected && (
          <Button size="lg" disabled={busy} onClick={() => act(connectStripe, true)}>
            <CreditCard className="mr-2 h-5 w-5" /> Connect Stripe
          </Button>
        )}

        {connected && !live && (
          <Button size="lg" disabled={busy} onClick={() => act(connectStripe, true)}>
            <ExternalLink className="mr-2 h-5 w-5" /> Finish setting up
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

        {connected && (
          <Button
            size="lg"
            variant="outline"
            disabled={busy}
            onClick={() => {
              // Confirmed, because it stops sales immediately: the offer is
              // withdrawn from the stall's public record and the Buy button
              // disappears for every shopper.
              if (!window.confirm('Stop taking card payments? Shoppers will no longer see a Buy button.')) return
              void act(disconnectStripe, false)
            }}
          >
            Stop taking card payments
          </Button>
        )}
      </div>

      {/* Said before they connect, not after their first payout. With direct
          charges the stall is merchant of record, which is what keeps their
          money out of an Imani balance — and it is also what puts disputes and
          reserves on them. */}
      <div className="mt-8 text-sm text-mono-500">
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
