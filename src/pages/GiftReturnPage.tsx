import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { formatDate, formatFace } from '../lib/format'
import { parseReturnFragment } from '../lib/lockedGifts'
import { readGiftReturn, takeBackGuestGift, type GiftReturnRead } from '../lib/lockedGiftsApp'
import { loadTrustedMints } from '../lib/trustedMint'
import { Button } from '../components/ui'
import { Centered } from '../components/ui/layout'
import { Outcome } from './ClaimLandingPage'

/**
 * A guest buyer's return link for a gift minted locked (#410 G14): `/gift-return#r=<R hex>`
 * (optionally `&t=<locked token>`). Shows the gift and where it stands (NUT-07): claimed, still
 * waiting until its date, or ready to take back. After that date, and only on the button, it is
 * taken back into the wallet that is open.
 *
 * Key hygiene: `R` is read once from the fragment, the fragment is scrubbed with
 * `history.replaceState` before anything else, and `R` lives only in this page's memory. It is never stored, logged, rendered or sent; the query that finds the gift is signed by
 * it, which proves the key without revealing it.
 */
function readOnce(): ReturnType<typeof parseReturnFragment> {
  const parsed = parseReturnFragment(window.location.hash)
  if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  return parsed
}

/** G17 (C): a gift taken back keeps the voucher's original expiry. */
function keepsExpiry(expiresAt: number | null): string {
  return expiresAt === null ? "The voucher doesn't expire." : `It keeps its original expiry: spend it by ${formatDate(expiresAt)}.`
}

export function GiftReturnPage({ authed }: { authed: boolean }) {
  const navigate = useNavigate()
  const [link] = useState(readOnce)
  const [read, setRead] = useState<GiftReturnRead | null>(null)
  const [checks, setChecks] = useState(0)
  const [step, setStep] = useState<'idle' | 'taking' | 'returned' | 'claimed' | 'failed'>('idle')
  const busy = useRef(false)
  const goHome = useCallback(() => navigate('/', { replace: true }), [navigate])

  useEffect(() => {
    if (!link) return
    let live = true
    void loadTrustedMints()
      .then(() => readGiftReturn(link.r, link.t))
      .then((r) => live && setRead(r), () => live && setRead({ kind: 'unreachable' }))
    return () => {
      live = false
    }
  }, [link, checks])

  // A page left open past the date checks again then, rather than saying "not yet" for ever.
  const waitingUntil = read?.kind === 'ok' && read.view.state === 'waiting' ? read.view.x : null
  useEffect(() => {
    if (waitingUntil === null) return
    const ms = Math.min(waitingUntil * 1000 - Date.now() + 1_000, 2_147_483_647)
    const timer = setTimeout(() => setChecks((n) => n + 1), Math.max(ms, 1_000))
    return () => clearTimeout(timer)
  }, [waitingUntil, checks])

  const takeBack = useCallback(async () => {
    if (!link || read?.kind !== 'ok' || busy.current) return
    busy.current = true
    setStep('taking')
    const out = await takeBackGuestGift(link.r, read.view.token)
    busy.current = false
    setStep(out.kind === 'returned' ? 'returned' : out.kind === 'claimed' ? 'claimed' : 'failed')
  }, [link, read])

  if (!link) return <Outcome tone="unavailable" title="Link incomplete" body="This return link is incomplete. Open it again from where you saved it." onDone={goHome} />
  if (!read) return <Centered>Checking your gift…</Centered>
  if (read.kind === 'not_found') return <Outcome tone="unavailable" title="Gift not found yet" body="We could not find this gift yet. Try again in a few minutes." onDone={goHome} />
  if (read.kind === 'unreachable') return <Outcome tone="unavailable" title="Try again" body="We could not reach the voucher service. Try again in a moment." onDone={goHome} />
  if (read.kind === 'refused') return <Outcome tone="unavailable" title="Gift unavailable" body="This gift could not be verified, so it cannot be taken back here." onDone={goHome} />
  if (step === 'taking') return <Centered>Taking your gift back…</Centered>
  if (step === 'returned') {
    return <Outcome tone="success" title="Gift taken back" body={`It is back in your wallet as a voucher. ${keepsExpiry(read.view.expiresAt)}`} onDone={goHome} />
  }
  if (step === 'claimed' || read.view.state === 'claimed') return <Outcome tone="unavailable" title="Gift claimed" body="Your recipient has claimed this gift." onDone={goHome} />

  const { view } = read
  const face = formatFace(view.faceMinor, { unit: view.unit, decimals: view.decimals })
  const date = formatDate(view.x)
  return (
    <Centered>
      <div className="w-full max-w-sm text-center">
        <h1 className="text-xl font-semibold">{view.stall ? `Your gift from ${view.stall}` : 'Your gift'}</h1>
        <p className="mt-2 text-2xl tabular-nums">{face}</p>
        {view.state === 'waiting' && <p className="mt-4 text-sm text-mono-500">Not claimed yet. You can take it back after {date} if it isn't claimed.</p>}
        {(view.state === 'waiting' || view.state === 'ready') && <p className="mt-2 text-sm text-mono-500">{keepsExpiry(view.expiresAt)}</p>}
        {view.state === 'unknown' && <p className="mt-4 text-sm text-mono-500">We could not check this gift right now. Try again in a moment.</p>}
        {view.state === 'ready' && (
          <>
            <p className="mt-4 text-sm text-mono-500">Not claimed by {date}. You can take it back now.</p>
            {authed ? (
              <Button size="lg" className="mt-6 w-full" onClick={() => void takeBack()}>
                Take it back into my wallet
              </Button>
            ) : (
              <p className="mt-6 text-sm">Open or create your Imani wallet on this device, then open this return link again from where you saved it.</p>
            )}
          </>
        )}
        {step === 'failed' && <p className="mt-4 text-sm text-red-600">It could not be taken back this time. Try again in a moment.</p>}
        <Button size="lg" variant="ghost" className="mt-2 w-full" onClick={goHome}>
          {authed ? 'Done' : 'Open my wallet'}
        </Button>
      </div>
    </Centered>
  )
}
