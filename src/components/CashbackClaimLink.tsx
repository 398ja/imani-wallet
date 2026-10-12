import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Check, Copy, QrCode, Share2, TriangleAlert } from 'lucide-react'

import { Button } from './ui'
import { revokeCashback, type RevokeOutcome } from '../lib/cashback'
import { CANCEL_QUESTION, bearerNote, canShare, shareLink } from '../lib/claimLinkShare'

/**
 * The claim link next to the code (claim links phase 2, spec 4.1): Show QR, Share link (or Copy
 * link) and the bearer note. The QR is behind a tap because of shoulder-surfing at the counter.
 *
 * The link carries the claim key in its fragment. It is rendered, shared or copied, and nothing
 * else: never logged, never stored, never put in a URL this app requests.
 */
export function ClaimLinkPanel({
  link,
  expiresAt,
  initiallyShown = false,
}: {
  link: string
  expiresAt?: string | number
  initiallyShown?: boolean
}) {
  const [shown, setShown] = useState(initiallyShown)
  const qr = useQrDataUrl(shown ? link : null)
  const [copied, setCopied] = useState(false)

  const share = async () => {
    const outcome = await shareLink(link)
    if (outcome === 'copied') {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="space-y-2">
      {shown ? (
        qr ? (
          <img
            src={qr}
            alt="QR code to claim this cashback"
            className="mx-auto w-full max-w-xs rounded-2xl bg-white p-4"
          />
        ) : null
      ) : (
        <Button variant="secondary" size="lg" className="w-full" onClick={() => setShown(true)}>
          <QrCode className="mr-2 h-4 w-4" /> Show QR
        </Button>
      )}
      <Button variant="secondary" size="lg" className="w-full" onClick={() => void share()}>
        {copied ? (
          <>
            <Check className="mr-2 h-4 w-4" /> Link copied
          </>
        ) : canShare() ? (
          <>
            <Share2 className="mr-2 h-4 w-4" /> Share link
          </>
        ) : (
          <>
            <Copy className="mr-2 h-4 w-4" /> Copy link
          </>
        )}
      </Button>
      <p className="text-center text-sm text-mono-500">{bearerNote(expiresAt)}</p>
    </div>
  )
}

/** A data URL for `text`, or null while it renders or when there is nothing to render. */
function useQrDataUrl(text: string | null): string | null {
  const [rendered, setRendered] = useState<{ text: string; url: string } | null>(null)
  useEffect(() => {
    if (!text) return
    let live = true
    QRCode.toDataURL(text, { width: 512, margin: 1 }).then(
      (url) => {
        if (live) setRendered({ text, url })
      },
      () => {
        // A link this short always fits. The Share and Copy buttons still work if it ever does not.
      },
    )
    return () => {
      live = false
    }
  }, [text])
  return rendered && rendered.text === text ? rendered.url : null
}

const CANCEL_FAILURE: Record<Exclude<RevokeOutcome['kind'], 'revoked'>, string> = {
  not_revocable: 'It could not be cancelled: the customer may already have claimed it.',
  failed: 'Could not cancel just now. The cashback may still be claimable. Try again.',
}

/**
 * Cancel cashback, asked inline as the app's other destructive questions are (spec 4.1, Q4).
 * Keeping it is the plain button; the cancel is a second tap.
 */
export function CancelCashback({
  cashbackId,
  onCancelled,
  onNotRevocable,
}: {
  cashbackId: string
  onCancelled: () => void
  /** The portal refused: it closed another way first. The screen re-reads the status. */
  onNotRevocable?: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cancel = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const outcome = await revokeCashback(cashbackId)
    setBusy(false)
    if (outcome.kind === 'revoked') {
      setConfirming(false)
      onCancelled()
      return
    }
    setError(CANCEL_FAILURE[outcome.kind])
    if (outcome.kind === 'not_revocable') onNotRevocable?.()
  }

  if (!confirming) {
    return (
      <div className="space-y-2">
        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        <Button variant="ghost" className="w-full" onClick={() => setConfirming(true)}>
          Cancel cashback
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
      <div className="flex gap-2">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="text-sm leading-relaxed">{CANCEL_QUESTION}</p>
      </div>
      {error && <p className="mt-2 text-sm">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
          Keep it
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel()}>
          {busy ? 'Cancelling…' : 'Yes, cancel it'}
        </Button>
      </div>
    </div>
  )
}
