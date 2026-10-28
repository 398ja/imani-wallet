import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '@wallet/components/ui/Button'
import { Alert, DetailRow, Notice, Panel, PageHeader, Screen } from '@wallet/components/ui/layout'
import { buttonClasses } from '@wallet/components/ui/buttonClasses'
import { api, date, salesLine, tillsLine, TIER_NAMES, type Me } from '../lib/api'

/** The stall's plan, its licences, card and cancellation, and "send it to my wallet again". */
export function AccountPage({ me, onRefresh }: { me: Me | null; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name)
    setError(null)
    setMessage(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const subs = me?.subscriptions ?? []
  const now = Date.now() / 1000
  const hasCard = subs.some((s) => s.has_card)
  // A licence still on its way (minted, the DM not yet confirmed) is re-read every few seconds for
  // a short while, so the page catches up with the delivery on its own instead of showing a stale
  // "On its way" left over from an earlier page.
  const pending = subs.some((s) => s.licences.some((l) => l.valid_to > now && l.state !== 'delivered'))
  const [polls, setPolls] = useState(0)
  useEffect(() => {
    if (polls > 0 && (!pending || polls > 10)) return
    const t = setTimeout(
      () => {
        void onRefresh()
        setPolls((n) => n + 1)
      },
      polls === 0 ? 0 : 3000,
    )
    return () => clearTimeout(t)
  }, [polls, pending, onRefresh])

  return (
    <Screen>
      <PageHeader title="Your plan" subtitle="Everything here also appears in your wallet under Settings › Subscription." />
      {error ? (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      {message ? <Notice tone="success">{message}</Notice> : null}

      {subs.length === 0 ? (
        <Panel className="mb-6 p-5">
          <p className="font-medium">You are on the Free plan.</p>
          <p className="mt-1 text-sm text-mono-500">Sell up to 100 in total and run one till. Upgrade whenever you need more.</p>
          <Link to="/plans" className={`${buttonClasses('primary', 'md')} mt-4 w-full`}>
            See plans
          </Link>
        </Panel>
      ) : (
        subs.map((s) => {
          const current = s.licences.filter((l) => l.valid_to > now).sort((a, b) => b.valid_to - a.valid_to)[0]
          return (
            <Panel key={s.subscription_id} className="mb-4 divide-y divide-mono-200 dark:divide-mono-800">
              <DetailRow label="Plan" value={`${TIER_NAMES[s.tier] ?? s.tier}${s.kind === 'custom' ? ' (granted)' : ''}`} />
              {s.limits ? <DetailRow label="Allows" value={[salesLine(s.limits), tillsLine(s.limits)].filter(Boolean).join(' · ')} /> : null}
              <DetailRow
                label="Status"
                value={s.status === 'revoked' ? 'Ended by Imani' : s.status === 'cancelled' ? 'Cancelled, runs to its end' : 'Active'}
              />
              {current ? <DetailRow label="Valid" value={`${date(current.valid_from)} to ${date(current.valid_to)}`} /> : null}
              {current ? (
                <DetailRow label="In your wallet" value={current.state === 'delivered' ? 'Sent' : 'On its way'} />
              ) : null}
            </Panel>
          )
        })
      )}

      <div className="flex flex-col gap-3">
        {subs.length > 0 ? (
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() =>
              void act('resend', async () => {
                const { sent } = await api.resend()
                setMessage(sent ? 'Sent to your wallet again. It appears within a minute.' : 'There is nothing current to send.')
                await onRefresh()
              })
            }
          >
            {busy === 'resend' ? 'Sending…' : 'Send my plan to my wallet again'}
          </Button>
        ) : null}
        {hasCard ? (
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              void act('portal', async () => {
                window.location.assign((await api.portal()).url)
              })
            }
          >
            {busy === 'portal' ? 'Opening…' : 'Card, invoices and cancellation'}
          </Button>
        ) : null}
        <Link to="/plans" className={buttonClasses('ghost', 'md')}>
          Change plan
        </Link>
      </div>
    </Screen>
  )
}
