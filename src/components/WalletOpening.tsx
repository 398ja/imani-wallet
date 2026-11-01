import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from './ui'
import type { WalletOpenStatus } from '../lib/wallet'

/**
 * How long an open may take before the screen stops saying "a moment" (#352).
 * A lone open takes milliseconds (measured on staging: the whole login is about
 * 2 s, almost all of it the network), so 8 s is already far outside normal.
 */
export const OPEN_TIME_LIMIT_MS = 8_000

/** The words, in one place so the jargon guard and the tests read the same copy. */
export const OPENING_COPY = {
  opening: 'Opening your wallet…',
  openingDetail: 'This only takes a moment.',
  blocked: 'Close your other wallet tabs to continue',
  blockedDetail:
    'This wallet is open in another tab or window. Close it there and this one will carry on by itself.',
  slow: 'This is taking longer than it should',
  slowDetail:
    'Your vouchers are safe. If the wallet is open in another tab or window, close it there and this one will carry on by itself.',
  released: 'This wallet changed in another tab',
  releasedDetail: 'Reload to see it as it is now. Your vouchers are safe.',
  tryAgain: 'Try again',
  reload: 'Reload',
  restoring: 'Bringing back your vouchers…',
} as const

/**
 * A quiet line while the vouchers come back from their backup after login.
 * The wallet is already usable; this only stops an empty list reading as an
 * empty wallet while the restore is still running.
 */
export function RestoringVouchers() {
  return (
    <p role="status" aria-live="polite" className="mx-auto mt-2 flex max-w-lg items-center justify-center gap-2 px-4 text-sm text-mono-500">
      <Loader2 className="h-4 w-4 shrink-0 text-mono-400 motion-safe:animate-spin" aria-hidden />
      {OPENING_COPY.restoring}
    </p>
  )
}

/**
 * What the user sees while the wallet's own storage opens.
 *
 * It used to be a bare "Opening wallet…" with no sign of life and no way on,
 * which sat there for as long as another tab held the store (#352). Now it
 * always says what is happening, spins while it is, tells the user what to do
 * when another tab is in the way, and never becomes a dead end: past the time
 * limit it explains and offers Try again. Never a logout or a wipe.
 */
export function WalletOpening({
  status,
  onRetry,
  onReload = () => window.location.reload(),
  timeLimitMs = OPEN_TIME_LIMIT_MS,
}: {
  status: WalletOpenStatus
  onRetry: () => void
  onReload?: () => void
  timeLimitMs?: number
}) {
  // Restarted by Try again: a fresh attempt gets its own full time limit. The
  // slow flag records WHICH attempt ran out, so a new attempt starts calm with
  // no reset inside the effect.
  const [attempt, setAttempt] = useState(0)
  const [slowAttempt, setSlowAttempt] = useState(-1)
  const slow = slowAttempt === attempt

  useEffect(() => {
    const timer = setTimeout(() => setSlowAttempt(attempt), timeLimitMs)
    return () => clearTimeout(timer)
  }, [attempt, timeLimitMs])

  const retry = () => {
    setAttempt((n) => n + 1)
    onRetry()
  }

  if (status === 'released') {
    return (
      <Waiting title={OPENING_COPY.released} detail={OPENING_COPY.releasedDetail} busy={false}>
        <Button className="w-full" onClick={onReload}>
          {OPENING_COPY.reload}
        </Button>
      </Waiting>
    )
  }

  if (status === 'blocked') {
    return (
      <Waiting title={OPENING_COPY.blocked} detail={OPENING_COPY.blockedDetail} busy>
        <Button variant="outline" className="w-full" onClick={retry}>
          {OPENING_COPY.tryAgain}
        </Button>
      </Waiting>
    )
  }

  if (slow) {
    return (
      <Waiting title={OPENING_COPY.slow} detail={OPENING_COPY.slowDetail} busy>
        <Button className="w-full" onClick={retry}>
          {OPENING_COPY.tryAgain}
        </Button>
      </Waiting>
    )
  }

  return <Waiting title={OPENING_COPY.opening} detail={OPENING_COPY.openingDetail} busy />
}

function Waiting({
  title,
  detail,
  busy,
  children,
}: {
  title: string
  detail: string
  busy: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      {/* One live region for every state, so a screen reader hears the change
          from "opening" to "close your other tabs" without moving focus. */}
      <div role="status" aria-live="polite" aria-busy={busy || undefined} className="w-full max-w-xs space-y-4 text-center">
        {busy && (
          <Loader2 className="mx-auto h-6 w-6 text-mono-400 motion-safe:animate-spin" aria-hidden data-testid="opening-spinner" />
        )}
        <div className="space-y-1">
          <h1 className="text-base font-semibold text-mono-900 dark:text-mono-50">{title}</h1>
          <p className="text-sm text-mono-500">{detail}</p>
        </div>
        {children}
      </div>
    </div>
  )
}
