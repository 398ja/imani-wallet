import { Link } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'

import { useBranding } from '../hooks/useBranding'
import { useInstalmentPlans } from '../hooks/useInstalmentPlans'
import { formatMoney, isRunning, pastDue, perPeriod, type InstalmentPlan } from '../lib/instalments'

/**
 * The wallet-home banner while any Monthly payment is past due (monthly payments spec, "Failed
 * payments"). Read on load: there is no push. No "update your card" link yet, because that
 * needs Stripe's customer portal on a connected account, which is unverified; so it says what
 * is true, that Stripe will retry, and to look for Stripe's email.
 *
 * Nothing at all when the read failed or nothing is past due.
 */
export function PastDueBanner({ buyerPubkey }: { buyerPubkey: string }) {
  const { plans } = useInstalmentPlans(buyerPubkey)
  const failed = plans === null ? [] : pastDue(plans)
  if (failed.length === 0) return null
  return <PastDueNotice plan={failed[0]} more={failed.length - 1} />
}

function PastDueNotice({ plan, more }: { plan: InstalmentPlan; more: number }) {
  const { branding } = useBranding(plan.stallPubkey)
  const name = branding?.organizationName ?? 'a stall'
  return (
    <div role="status" className="mb-6 flex gap-2 rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="text-sm leading-relaxed">
        <p className="font-medium">
          {plan.interval === 'month' ? 'A monthly payment' : 'A payment'} to {name} didn't go through.
          {more > 0 ? ` And ${more} more.` : ''}
        </p>
        <p>Stripe will try again. Check the email Stripe sent you.</p>
        <Link to={`/settings/monthly-payments/${encodeURIComponent(plan.planId)}`} className="font-medium underline underline-offset-4">
          {plan.interval === 'month' ? 'See monthly payment' : 'See payment'}
        </Link>
      </div>
    </div>
  )
}

/**
 * The quiet line on a stall's page: "You pay £40 a month." Shown only for a running plan with
 * this stall, and links to its detail.
 */
export function StallMonthlyLine({ buyerPubkey, stallPubkey }: { buyerPubkey: string | undefined; stallPubkey: string }) {
  const { plans } = useInstalmentPlans(buyerPubkey)
  const plan = plans?.find((p) => p.stallPubkey === stallPubkey && isRunning(p))
  if (!plan) return null
  return (
    <p className="text-center text-sm text-mono-500">
      <Link to={`/settings/monthly-payments/${encodeURIComponent(plan.planId)}`} className="underline underline-offset-4">
        You pay {formatMoney(plan.amountMinor, plan.currency)} {perPeriod(plan.interval)}.
      </Link>
    </p>
  )
}
