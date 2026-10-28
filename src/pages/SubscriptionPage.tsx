import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, DetailRow, Button, Centered, buttonClasses } from '../components/ui'
import { formatDate, formatFace } from '../lib/format'
import { explain, licenceStatus, type LicenceStatus } from '../lib/licenceStatus'
import { refreshCatalog, salesPosition, SUBSCRIPTION_SITE_URL, type SalesPosition } from '../lib/entitlement'
import { openSisterSite } from '../lib/sisterSiteSigner'
import { GRACE_WINDOW_SECONDS } from '@imani/licence'
import { listTransactions, onWalletChanged } from '../lib/wallet'

/**
 * Subscription diagnostics: what the licence check believes, and why.
 *
 * **The screen is not the point.** It is the smallest real gate that exercises
 * purchase, delivery, verification, expiry, grace and lapse end to end. Doing
 * that against something no customer sees means a wrongly-open or wrongly-closed
 * gate is a development detail rather than an incident — where discovering the
 * same bug through the terminals feature would mean discovering it as a
 * merchant unable to open their second till.
 *
 * That is the sequencing ADR 0007 and the subscriptions spec chose: the licence
 * machinery ships before the feature it gates, so the gated path is the only
 * path anyone ever exercises.
 *
 * ## It is gated by the REAL check, not a hidden route
 *
 * The refusal below is `licenceStatus`'s own, rendered. If this screen were
 * merely unlisted, or hidden behind a debug flag, it would prove nothing: the
 * thing being tested is whether the gate opens and closes correctly, and a gate
 * that is never consulted cannot be tested. So an unlicensed device reaches this
 * URL and is told, in the same words a customer would get, why it is closed.
 *
 * ## It is also the support tool
 *
 * Every later ticket inherits this. When a merchant asks why their terminals
 * stopped, the answer is a sentence on this screen plus a date — rather than a
 * log line on a server that never saw the licence, because nothing server-side
 * ever does (that is the whole architecture).
 */
export function SubscriptionPage({ pubkey, currency }: { pubkey: string; currency?: string }) {
  const [status, setStatus] = useState<LicenceStatus | null>(null)
  const [position, setPosition] = useState<SalesPosition | null>(null)
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      // A newer signed catalog changes the numbers below; fetched first, best effort.
      await refreshCatalog()
      const next = await licenceStatus({ pubkey })
      setStatus(next)
      // The plan and what has been used of it (#407). Best effort: a ledger that cannot be read
      // leaves the licence verdict above on its own rather than hiding it.
      if (currency) {
        try {
          setPosition(salesPosition(next, currency, await listTransactions()))
        } catch {
          setPosition(null)
        }
      }
    } finally {
      setChecking(false)
    }
  }, [pubkey, currency])

  useEffect(() => {
    void check()
    // A licence arrives by DM like everything else, so the wallet changing is
    // how this screen learns a subscription was delivered or renewed. Without
    // it, "no subscription yet" would persist until a manual reload — and
    // "delivered with no further step" is precisely what ticket 04 asserts.
    return onWalletChanged(() => void check())
  }, [check])

  if (!status) return <Centered>Checking your subscription…</Centered>

  const { decision } = status
  const granted = decision.granted

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader
        title="Subscription"
        subtitle="What this device believes about your subscription, and why"
      />

      <Panel className="mb-6 p-4">
        <div className="flex items-start gap-3">
          <Verdict granted={granted} source={granted ? decision.source : undefined} />
          <div className="min-w-0">
            <p className="font-medium text-mono-900 dark:text-mono-50">
              {granted
                ? decision.source === 'grace'
                  ? 'Working, unconfirmed'
                  : 'Active'
                : 'Not active'}
            </p>
            {/* The sentence, not the reason code. `explain` is exhaustive over
                every reason both modules can produce, so a state added later
                without wording here fails the build rather than showing a
                merchant `grace-elapsed`. */}
            <p className="mt-1 text-sm text-mono-500">{explain(status)}</p>
          </div>
        </div>
      </Panel>

      {position ? <PlanPanel position={position} /> : null}

      {/* What it believes, itemised. A support conversation needs the dates and
          the id, not only the verdict — "expired on the 3rd" is answerable and
          "not active" is not. Shown for a REFUSAL too, which is when it is
          actually needed. */}
      <Panel className="mb-6 divide-y divide-mono-200 dark:divide-mono-800">
        <DetailRow
          label="Until"
          value={
            status.licence?.expiresAt
              ? formatDate(status.licence.expiresAt)
              : 'No subscription on this device'
          }
        />
        {granted ? (
          <DetailRow
            label="Unlocks"
            value={decision.grant.features.join(', ') || 'nothing'}
          />
        ) : null}
        {granted && decision.source === 'grace' && decision.graceExpiresAt ? (
          // Only under grace, because only then is it a deadline. Showing "24h
          // remaining" on a healthy subscription would invent an anxiety that
          // does not exist: a device that can check has no window to run out.
          <DetailRow
            label="Offline until"
            value={`${formatDate(decision.graceExpiresAt)} (${hoursLeft(
              decision.graceExpiresAt,
              status.checkedAt,
            )})`}
          />
        ) : null}
        {status.licence?.subscriptionId ? (
          // The thread support follows. It survives renewal and re-issue, which
          // is exactly why it is the one identifier worth showing.
          <DetailRow label="Subscription" value={status.licence.subscriptionId} />
        ) : null}
        {status.licence?.faceValue != null && status.licence.faceUnit ? (
          <DetailRow
            label="Paid"
            value={formatFace(status.licence.faceValue, {
              unit: status.licence.faceUnit,
              decimals: status.licence.faceUnit === 'sat' ? 0 : 2,
            })}
          />
        ) : null}
        {status.licence?.pilot ? <DetailRow label="Type" value="Pilot" /> : null}
        <DetailRow label="Checked" value={formatDate(status.checkedAt)} />
      </Panel>

      <Button onClick={() => void check()} disabled={checking} variant="secondary">
        {/* `motion-reduce:animate-none` because a continuous rotation is exactly
            the vestibular motion that setting asks us to drop. The word beside
            it already says "Checking…", so nothing is lost by stopping it. */}
        <RefreshCw
          className={`mr-2 h-4 w-4 ${checking ? 'animate-spin motion-reduce:animate-none' : ''}`}
          aria-hidden
        />
        {checking ? 'Checking…' : 'Check again'}
      </Button>

      {/* Bought on the subscription site (#407 §6, #411). This tap opens it in a new tab and THIS
          wallet signs the site's login (sisterSiteSigner.ts): the stall arrives signed in, with no
          passphrase and no login page. The plain href is the fallback when the browser refuses the
          tab, and the site then says "open this from your wallet". */}
      <a
        href={SUBSCRIPTION_SITE_URL}
        target="imani-subscription"
        rel="opener"
        onClick={(e) => {
          if (openSisterSite(SUBSCRIPTION_SITE_URL, 'imani-subscription')) e.preventDefault()
        }}
        className={`${buttonClasses(granted ? 'secondary' : 'primary', 'md')} mt-4 w-full`}
      >
        {granted ? 'Change or renew my plan' : 'Upgrade my plan'}
      </a>
      <p className="mt-2 text-sm text-mono-500">
        Opens Imani plans in a new tab, signed in as this stall. Pay by card; your new plan arrives on this device on its own.
      </p>
    </Screen>
  )
}

const TIER_NAMES: Record<string, string> = { free: 'Free', basic: 'Basic', pro: 'Pro', custom: 'Custom' }

/**
 * The plan, in the numbers a merchant checks against their own day: what tier, how much has been
 * sold of how much, and how many tills it allows.
 */
function PlanPanel({ position }: { position: SalesPosition }) {
  const { entitlement, used } = position
  const sales = entitlement.sales
  const decimals = sales?.currency === 'SAT' ? 0 : 2
  const money = (minor: number) => formatFace(minor, { unit: sales?.currency ?? '', decimals })
  const pct = sales && sales.amount > 0 ? Math.min(100, Math.round((used / sales.amount) * 100)) : 0

  return (
    <Panel className="mb-6 divide-y divide-mono-200 dark:divide-mono-800">
      <DetailRow label="Plan" value={TIER_NAMES[entitlement.tier] ?? entitlement.tier} />
      <DetailRow
        label={sales?.period === 'month' ? 'Sold this month' : 'Sold'}
        value={sales ? `${money(used)} of ${money(sales.amount)}` : 'No limit'}
      />
      {sales ? (
        <div className="px-4 py-3">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-mono-200 dark:bg-mono-800"
            role="progressbar"
            aria-label="Sales used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className={`h-full ${pct >= 100 ? 'bg-red-600' : pct >= 80 ? 'bg-amber-500' : 'bg-green-600'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : null}
      <DetailRow
        label="Tills"
        value={entitlement.terminals === null ? 'No limit' : `${entitlement.terminals} besides this device`}
      />
      {entitlement.features.length ? (
        <DetailRow label="Includes" value={entitlement.features.map(featureName).join(', ')} />
      ) : null}
    </Panel>
  )
}

function featureName(f: string): string {
  return f === 'api' ? 'API access' : f === 'ecommerce' ? 'Online shop' : f === 'terminals' ? 'Extra tills' : f
}

/**
 * The verdict mark.
 *
 * Three states, three marks, three colours — because "working" and "working,
 * but we cannot confirm it" are genuinely different situations, and a screen
 * that showed the same tick for both could never warn anyone before the grace
 * window drained.
 *
 * `aria-hidden` on all three: the heading and the sentence beside them already
 * say what they mean, and colour is never the only carrier.
 */
function Verdict({ granted, source }: { granted: boolean; source?: 'verified' | 'grace' }) {
  if (!granted) return <ShieldAlert className="h-6 w-6 shrink-0 text-red-600" aria-hidden />
  if (source === 'grace') {
    return <ShieldQuestion className="h-6 w-6 shrink-0 text-amber-600" aria-hidden />
  }
  return <ShieldCheck className="h-6 w-6 shrink-0 text-green-600" aria-hidden />
}

/**
 * "about 20 hours left", from the two numbers the decision already carries.
 *
 * Derived from `graceExpiresAt` and the moment of the check rather than from
 * `Date.now()`, so the words agree with the decision they describe instead of
 * drifting from it while the screen sits open.
 */
function hoursLeft(graceExpiresAt: number, checkedAt: number): string {
  const seconds = Math.max(0, graceExpiresAt - checkedAt)
  if (seconds >= 3600) {
    const hours = Math.round(seconds / 3600)
    return `about ${hours} hour${hours === 1 ? '' : 's'} left`
  }
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`
}

/** Exported for the test that pins the window against the package's constant. */
export const DIAGNOSTICS_GRACE_WINDOW_SECONDS = GRACE_WINDOW_SECONDS
