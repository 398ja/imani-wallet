import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Button, Screen, PageHeader, Centered } from '../components/ui'
import { codeToWords, completeStripeOAuth, startStripeOAuth } from '../lib/stripeAccount'

/** The mapped words, never offering "try again": the code is spent, so the only way on is a fresh start. */
function failureWords(result: { reason: string; code?: string }): string {
  const words = (codeToWords(result.code, result.reason)?.words ?? result.reason)
    .replace(/\s*(please )?try again\.?/i, '')
    .trim()
  return /start again/i.test(words) ? words : `${words} Start again.`
}

/**
 * Where Stripe sends the stall back after "I already have a Stripe account".
 *
 * In this order, and only this order (spec, "The OAuth return page"):
 *
 * 1. read `code`, `state` and `error`, then IMMEDIATELY strip them from the URL with
 *    `history.replaceState`, so the one-time code cannot leak through the address bar, history or
 *    a Referer header;
 * 2. post them once, and NEVER retry: a code used twice makes Stripe revoke the connection;
 * 3. on any failure say "Start again" and offer a button that begins a fresh consent, never a
 *    "try again" on the same code.
 *
 * The once-guard is module-level and keyed by code, because React StrictMode mounts effects twice
 * and a ref does not survive the remount.
 */
const posted = new Set<string>()

/** For tests only. */
export function resetStripeConnectedGuard() {
  posted.clear()
}

type View =
  | { kind: 'working' }
  | { kind: 'denied' }
  | { kind: 'failed'; words: string }

export function StripeConnectedPage() {
  const navigate = useNavigate()
  const [view, setView] = useState<View>({ kind: 'working' })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    const code = query.get('code')
    const state = query.get('state')
    const error = query.get('error')
    // Before anything else, and before any network call.
    if (window.location.search) {
      window.history.replaceState(window.history.state, '', window.location.pathname)
    }

    if (error === 'access_denied') {
      setView({ kind: 'denied' })
      return
    }
    if (!code || !state) {
      // A reload lands here with the query already gone: the code is spent either way.
      if (!posted.size) setView({ kind: 'failed', words: 'That took too long, or was already used. Start again.' })
      return
    }
    if (posted.has(code)) return
    posted.add(code)

    void completeStripeOAuth(code, state).then((result) => {
      if (result.kind === 'ok') {
        navigate('/settings/payments?stripe=return', { replace: true })
      } else {
        setView({ kind: 'failed', words: failureWords(result) })
      }
    })
  }, [navigate])

  const startAgain = async () => {
    setBusy(true)
    try {
      const result = await startStripeOAuth()
      if (result.kind === 'ok') {
        window.location.href = result.authorizeUrl
        return
      }
      setView({ kind: 'failed', words: failureWords(result) })
    } finally {
      setBusy(false)
    }
  }

  if (view.kind === 'working') return <Centered>Connecting your Stripe account…</Centered>

  return (
    <Screen>
      <PageHeader title="Card payments" />
      {view.kind === 'denied' ? (
        <p className="mb-6 text-[15px] leading-relaxed text-mono-500">Nothing was connected.</p>
      ) : (
        <p className="mb-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {view.words}
        </p>
      )}
      <div className="grid gap-3">
        <Button size="lg" disabled={busy} onClick={startAgain}>
          {view.kind === 'denied' ? 'Connect again' : 'Start again'}
        </Button>
        <Button size="lg" variant="outline" onClick={() => navigate('/settings/payments')}>
          Back to Card payments
        </Button>
      </div>
    </Screen>
  )
}
