import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardPaste } from 'lucide-react'
import { PaymentRequestHandler } from 'imani-qr'

import { Button, Screen, BackLink, PageHeader, Alert } from '../components/ui'

/**
 * Pay: scan a merchant's voucher payment request QR (NUT-18V, `vreqA…`).
 *
 * Detection and normalisation come from imani-qr's PaymentRequestHandler, which
 * also accepts the `cashu:` URI form. On a hit we hand off to /pay via the
 * paymentRequest query param — the same paramKey the vanilla app's QR router
 * uses, so both entry points agree and the URL is replayable when debugging.
 */
export function ScanPage() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)

  const accept = (text: string) => {
    const handler = new PaymentRequestHandler()
    if (!handler.validate(text)) {
      setError('That is not a voucher payment request.')
      return
    }
    navigate(`/pay?paymentRequest=${encodeURIComponent(text.trim())}`)
  }

  useEffect(() => {
    let scanner: { start(): Promise<void>; destroy(): void } | undefined
    let cancelled = false

    ;(async () => {
      const { default: QrScanner } = await import('qr-scanner')
      if (cancelled || !videoRef.current) return

      scanner = new QrScanner(videoRef.current, (result) => accept(result.data), {
        highlightScanRegion: true,
        highlightCodeOutline: true,
      })
      try {
        await scanner.start()
      } catch (e) {
        setError(
          e instanceof Error
            ? `Camera unavailable: ${e.message}. Paste the request instead.`
            : 'Camera unavailable. Paste the request instead.',
        )
      }
    })()

    return () => {
      cancelled = true
      scanner?.destroy()
    }
    // accept closes over navigate only, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const paste = async () => {
    try {
      accept(await navigator.clipboard.readText())
    } catch {
      setError('Could not read the clipboard.')
    }
  }

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Scan to pay" />

      <div className="overflow-hidden rounded-2xl bg-mono-900">
        <video ref={videoRef} className="aspect-square w-full object-cover" />
      </div>

      {error && <div className="mt-3"><Alert>{error}</Alert></div>}

      <Button variant="outline" className="mt-4 w-full" onClick={paste}>
        <ClipboardPaste className="mr-2 h-4 w-4" /> Paste request
      </Button>
    </Screen>
  )
}
