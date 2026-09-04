import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, DetailRow, Button, Centered } from '../components/ui'
import { formatDate, formatFace } from '../lib/format'
import { explain, licenceStatus, type LicenceStatus } from '../lib/licenceStatus'
import { GRACE_WINDOW_SECONDS } from '@imani/licence'
import { onWalletChanged } from '../lib/wallet'

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
export function SubscriptionPage({ pubkey }: { pubkey: string }) {
  const [status, setStatus] = useState<LicenceStatus | null>(null)
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      setStatus(await licenceStatus({ pubkey }))
    } finally {
      setChecking(false)
    }
  }, [pubkey])

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
        <RefreshCw className={`mr-2 h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
        {checking ? 'Checking…' : 'Check again'}
      </Button>

      {/* Selling is out-of-band while this is a pilot, so the way to get one is
          to ask a person. A screen that said "Subscribe" and did nothing would
          be worse than one that says who to talk to. */}
      {!granted ? (
        <p className="mt-4 text-sm text-mono-500">
          Subscriptions are currently arranged directly with us. Get in touch and
          we will send one to this device.
        </p>
      ) : null}
    </Screen>
  )
}

function Verdict({ granted, source }: { granted: boolean; source?: 'verified' | 'grace' }) {
  if (!granted) return <ShieldAlert className="h-6 w-6 shrink-0 text-red-600" />
  // Deliberately a different mark for grace: "working" and "working, but we
  // cannot confirm it" are different states, and a screen that showed the same
  // tick for both could not warn anyone before the window drained.
  if (source === 'grace') return <ShieldQuestion className="h-6 w-6 shrink-0 text-amber-600" />
  return <ShieldCheck className="h-6 w-6 shrink-0 text-green-600" />
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
