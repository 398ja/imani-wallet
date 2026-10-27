import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'

import { Button } from '@wallet/components/ui/Button'
import { Alert, Panel } from '@wallet/components/ui/layout'
import { api, featureName, salesLine, tillsLine, TIER_NAMES, type Me, type Plan } from '../lib/api'
import type { Signer } from '../lib/signer'

/**
 * The plans, from the catalog the service publishes, so the numbers here are the ones the wallet
 * enforces. Buying opens Stripe Checkout (card only, #407 Q9); the licence arrives in the wallet.
 */
export function PlansPage({ signer, me }: { signer: Signer | null; me: Me | null }) {
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [term, setTerm] = useState<'monthly' | 'annual'>('monthly')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.plans().then(setPlans, (e: Error) => setError(e.message))
  }, [])

  const current = me?.subscriptions.find((s) => s.kind === 'subscription' && s.status !== 'revoked')?.tier ?? 'free'

  const buy = async (tier: string) => {
    if (!signer) return navigate(`/sign-in?next=/plans`)
    setError(null)
    setBusy(tier)
    try {
      const { url } = await api.checkout(signer, tier, term)
      window.location.assign(url)
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }

  return (
    <main className="mx-auto max-w-3xl p-5">
      <h1 className="mt-6 text-3xl font-semibold">Plans for your stall</h1>
      <p className="mt-2 text-callout text-mono-500">
        Start free. Upgrade when you sell more or need more tills. Paid by card, cancel any time, and your plan arrives in your
        Imani wallet on its own.
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
          const sellable = plan.terms.includes(term)
          return (
            <Panel key={plan.tier} className={`flex flex-col p-5 ${plan.tier === 'basic' ? 'ring-2 ring-mono-900 dark:ring-mono-50' : ''}`}>
              <h2 className="text-xl font-semibold">{TIER_NAMES[plan.tier] ?? plan.tier}</h2>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {[salesLine(plan.limits), tillsLine(plan.limits), ...plan.features.filter((f) => f !== 'terminals').map(featureName)]
                  .filter(Boolean)
                  .map((line) => (
                    <li key={line} className="flex gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden /> {line}
                    </li>
                  ))}
              </ul>
              <div className="mt-6">
                {isCurrent ? (
                  <p className="text-center text-sm text-mono-500">Your current plan</p>
                ) : plan.tier === 'free' ? (
                  <p className="text-center text-sm text-mono-500">Included with every stall</p>
                ) : (
                  <Button className="w-full" disabled={!sellable || busy !== null} onClick={() => void buy(plan.tier)}>
                    {busy === plan.tier ? 'Opening checkout…' : sellable ? `Choose ${TIER_NAMES[plan.tier] ?? plan.tier}` : 'Not available yearly'}
                  </Button>
                )}
              </div>
            </Panel>
          )
        })}
      </div>

      <p className="mt-6 text-sm text-mono-500">
        Prices include VAT where it applies; business customers can add a VAT number at checkout. You sign in with your stall’s
        key, so there is no account to create.
      </p>
    </main>
  )
}
