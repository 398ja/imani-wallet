import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'

import { Alert, Button, Notice } from './ui'
import {
  fetchCardSalesStatus,
  turnOnCardSales,
  type CardSalesResult,
  type CardSalesStatus,
} from '../lib/cardSalesEnrolment'
import { getSigner } from '../lib/nap'

/**
 * "Turn on card sales", beside Connect Stripe (imani-wallet#298).
 *
 * Connecting Stripe lets a stall be PAID by card. Issuing the voucher it was paid for is a second
 * thing: the purchase issuer must hold this stall's say-so (a credential and a delegation). This is
 * where the stall gives it, from this phone, with its own key, and where it sees whether it holds.
 *
 * Three states, one sentence each, and the action only where there is something to do:
 *
 * - **Card sales: on.** Nothing to press.
 * - **Card sales: needs setup.** One primary button, which does the whole thing.
 * - **Couldn't check.** Said plainly, with Check again. Not "off": a blip is not a fact.
 */
export interface CardSalesDeps {
  status?: () => Promise<CardSalesResult>
  turnOn?: () => Promise<CardSalesResult>
}

const defaultStatus = () => fetchCardSalesStatus(getSigner())
const defaultTurnOn = () => turnOnCardSales({ signer: getSigner() })

export function CardSalesSection({ deps = {} }: { deps?: CardSalesDeps }) {
  const status = deps.status ?? defaultStatus
  const turnOn = deps.turnOn ?? defaultTurnOn
  const [state, setState] = useState<CardSalesStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  const apply = useCallback((result: CardSalesResult) => {
    if (result.kind === 'ok') {
      setState(result.status)
      setError(null)
    } else {
      setError(result.reason)
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    let live = true
    void status()
      .catch((): CardSalesResult => ({ kind: 'error', reason: 'Could not check card sales.' }))
      .then((result) => {
        if (live) apply(result)
      })
    return () => {
      live = false
    }
    // Once on mount; `status` is a stable default or a test's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (fn: () => Promise<CardSalesResult>) => {
    setBusy(true)
    setError(null)
    try {
      apply(await fn().catch((): CardSalesResult => ({ kind: 'error', reason: 'Something went wrong. Nothing was set up.' })))
    } finally {
      setBusy(false)
    }
  }

  const on = state?.ready === true
  const heading = !loaded ? 'Card sales' : on ? 'Card sales: on' : state ? 'Card sales: needs setup' : "Couldn't check card sales"
  const detail = !loaded
    ? 'Checking…'
    : on
      ? 'Card payments become vouchers in your buyers’ wallets automatically.'
      : state
        ? state.enrolled
          ? `${state.reason ?? 'Card sales need setting up again.'} Shoppers can’t buy by card until then.`
          : 'Shoppers can’t buy by card yet. Turn card sales on so each payment becomes a voucher.'
        : 'Shoppers can’t buy by card until this is checked.'

  return (
    <section aria-labelledby="card-sales-heading" className="mb-6 rounded-2xl border border-mono-200 p-4 dark:border-mono-800">
      <div className="flex items-start gap-3">
        <ShieldCheck
          className={`mt-0.5 h-5 w-5 shrink-0 ${on ? 'text-green-700 dark:text-green-400' : 'text-mono-400'}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p id="card-sales-heading" className="text-[17px] font-semibold tracking-[-0.01em]">
            {heading}
          </p>
          <p className="mt-1 text-[15px] leading-relaxed text-mono-500">{detail}</p>
        </div>
      </div>

      {error && (
        <div className="expand-row mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      {busy && (
        <div className="mt-3">
          <Notice tone="warning">Setting up card sales. This takes a few seconds. Keep this screen open.</Notice>
        </div>
      )}

      {loaded && !on && (
        <div className="mt-4 grid gap-3">
          {state ? (
            <Button size="lg" disabled={busy} onClick={() => run(turnOn)}>
              {busy ? 'Turning on…' : state.enrolled ? 'Set up card sales again' : 'Turn on card sales'}
            </Button>
          ) : (
            <Button size="lg" variant="outline" disabled={busy} onClick={() => run(status)}>
              Check again
            </Button>
          )}
        </div>
      )}

      {loaded && !on && state && (
        <p className="mt-3 text-sm leading-relaxed text-mono-500">
          Signed on this phone with your key, which never leaves it. Imani’s card issuer can then
          issue your vouchers for card payments, and nothing else.
        </p>
      )}
    </section>
  )
}
