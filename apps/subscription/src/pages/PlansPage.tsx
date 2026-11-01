import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'

import { Button } from '@wallet/components/ui/Button'
import { Alert, Panel } from '@wallet/components/ui/layout'
import {
  api,
  featureName,
  HIGHLIGHTED_TIER,
  money,
  PLAN_COPY,
  priceLine,
  salesLine,
  SessionEnded,
  tillsLine,
  TIER_NAMES,
  yearlySaving,
  type Me,
  type Plan,
  type Term,
} from '../lib/api'

/**
 * The plans, as www.imani.casa/pricing publishes them: Starter, Essentials and Pro.
 *
 * Which plans appear, and their limits, come from the service (the catalog the wallet enforces,
 * filtered to tiers with a card price). Prices come from Stripe, in GBP, so the page shows what
 * Checkout will charge. A partnership tier (Town / BID Partner) is arranged with us and is never
 * offered here. Buying opens Stripe Checkout (card only, #407 Q9); the licence arrives in the wallet.
 */
export function PlansPage({ me, onSessionEnded }: { me: Me | null; onSessionEnded: () => void }) {
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [term, setTerm] = useState<Term>('annual')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.plans().then(setPlans, (e: Error) => setError(e.message))
  }, [])

  const current = me?.subscriptions.find((s) => s.kind === 'subscription' && s.status !== 'revoked')?.tier ?? 'free'
  const bestSaving = Math.max(0, ...(plans ?? []).map((p) => yearlySaving(p) ?? 0))

  const buy = async (tier: string) => {
    setError(null)
    setBusy(tier)
    try {
      const { url } = await api.checkout(tier, term)
      window.location.assign(url)
    } catch (e) {
      if (e instanceof SessionEnded) return onSessionEnded()
      setError((e as Error).message)
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-5">
      <h1 className="mt-6 text-3xl font-semibold">Plans for your shop</h1>
      <p className="mt-2 text-callout text-mono-500">
        No percentage of your sales. Ever. Every plan keeps 100% of every voucher you sell. Paid by card, cancel any time,
        and your plan arrives in your Imani wallet on its own.
      </p>

      <div role="radiogroup" aria-label="Billing" className="mt-6 inline-flex rounded-xl bg-mono-100 p-1 dark:bg-mono-900">
        {(['monthly', 'annual'] as const).map((t) => (
          <button
            key={t}
            role="radio"
            aria-checked={term === t}
            type="button"
            onClick={() => setTerm(t)}
            className={`pressable rounded-lg px-4 py-1.5 text-sm font-medium ${term === t ? 'bg-white shadow-sm dark:bg-mono-800' : 'text-mono-500'}`}
          >
            {t === 'monthly' ? 'Monthly' : 'Yearly'}
            {t === 'annual' && bestSaving > 0 ? <span className="ml-1 text-green-700 dark:text-green-500">Save up to {bestSaving}%</span> : null}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mt-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {(plans ?? []).map((plan) => {
          const isCurrent = plan.tier === current
          const sellable = plan.terms.includes(term) && Boolean(plan.prices?.[term])
          const name = TIER_NAMES[plan.tier] ?? plan.tier
          const copy = PLAN_COPY[plan.tier]
          const lines = [
            salesLine(plan.limits),
            tillsLine(plan.limits),
            '0% commission on sales',
            ...plan.features.filter((f) => f !== 'terminals').map(featureName),
            ...(copy?.includes ?? []),
          ].filter(Boolean)
          return (
            <Panel
              key={plan.tier}
              className={`flex flex-col p-5 ${plan.tier === HIGHLIGHTED_TIER ? 'ring-2 ring-mono-900 dark:ring-mono-50' : ''}`}
            >
              <h2 className="text-xl font-semibold">{name}</h2>
              <PriceTag plan={plan} term={term} />
              {copy ? <p className="mt-1 text-sm text-mono-500">{copy.bestFor}</p> : null}
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {lines.map((line) => (
                  <li key={line} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden /> {line}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                {isCurrent ? (
                  <p className="text-center text-sm text-mono-500">Your current plan</p>
                ) : plan.tier === 'free' ? (
                  <p className="text-center text-sm text-mono-500">Included with every shop</p>
                ) : (
                  <Button className="w-full" disabled={!sellable || busy !== null} onClick={() => void buy(plan.tier)}>
                    {busy === plan.tier
                      ? 'Opening checkout…'
                      : sellable
                        ? `Choose ${name}`
                        : plan.terms.includes(term)
                          ? 'Unavailable right now'
                          : term === 'annual'
                            ? 'Not available yearly'
                            : 'Not available monthly'}
                  </Button>
                )}
              </div>
            </Panel>
          )
        })}
      </div>

      <p className="mt-6 text-sm text-mono-500">
        Starter: when you have issued £100 in vouchers, upgrade to keep selling. Vouchers you have already sold stay valid.
        We check every Essentials and Pro business before its verified badge goes live.
      </p>
      <p className="mt-2 text-sm text-mono-500">
        Prices are in pounds sterling and include VAT where it applies; business customers can add a VAT number at
        checkout. You are signed in through your shop’s wallet, so there is no account to create.
      </p>
    </div>
  )
}

/** "£70/year, about £5.83/month" or "£8/month, or £70/year", from the Stripe prices. */
function PriceTag({ plan, term }: { plan: Plan; term: Term }) {
  if (plan.tier === 'free') return <p className="mt-2 text-2xl font-semibold">Free</p>
  const line = priceLine(plan, term)
  if (!line) return <p className="mt-2 text-sm text-mono-500">Price unavailable</p>
  const annual = plan.prices?.annual
  const saving = yearlySaving(plan)
  const note =
    term === 'annual' && annual
      ? `${saving ? `save ${saving}%, ` : ''}about ${money(Math.round(annual.amount / 12), annual.currency, true)}/month`
      : term === 'monthly'
        ? (priceLine(plan, 'annual') && `or ${priceLine(plan, 'annual')}`) || null
        : null
  return (
    <div className="mt-2">
      <p className="text-2xl font-semibold">{line}</p>
      {note ? <p className="text-sm text-mono-500">{note}</p> : null}
    </div>
  )
}
