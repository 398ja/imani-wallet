import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ClipboardPaste } from 'lucide-react'
import { PaymentRequestHandler } from 'imani-qr'

import { Button, Screen, BackLink, PageHeader, Alert, Input } from '../components/ui'
import { toRecipientPubkey } from '../lib/issue'
import { readClipboard } from '../lib/native'

/**
 * Scan: the one camera for both things a customer points it at.
 *
 * Two kinds of code exist, and this screen only routes between them:
 *
 *  - a merchant's voucher payment request (NUT-18V, `vreqA…`) → `/pay`.
 *    Detection and normalisation come from imani-qr's PaymentRequestHandler,
 *    which also accepts the `cashu:` URI form. The `paymentRequest` param is the
 *    same paramKey the vanilla app's QR router uses, so both entry points agree
 *    and the URL is replayable when debugging.
 *  - somebody's address — a NIP-05 handle, npub, or raw hex, which is what the
 *    `/receive` screen shows → `/send`.
 *
 * The payment request is tried first because it is the cheaper answer: a local
 * string check, where an address costs a round trip to resolve.
 */
export function ScanPage() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  // Revealed only when the clipboard read fails, because then this screen has no
  // other way in: unlike ScanRecipient it carries no standing text field, so a
  // refused read left a camera that would not open and a button that would not
  // paste. Reading the clipboard is not something a page can guarantee — Firefox
  // does not give readText to web content at all, and Chrome's prompt is the
  // user's to deny — so the fallback is a field they can long-press into.
  const [typed, setTyped] = useState<string | null>(null)
  // A handle costs a round trip to resolve, and the scanner fires several times
  // a second on the same code — without this the phone opens a dozen identical
  // lookups while the first is still in flight. A ref, not state: it must be
  // read and written within one call, before any re-render could deliver it.
  const resolving = useRef(false)

  /** The one router, so a pasted code goes exactly where a scanned one does. */
  const accept = useCallback(
    async (text: string) => {
      if (resolving.current) return
      resolving.current = true
      try {
        if (new PaymentRequestHandler().validate(text)) {
          navigate(`/pay?paymentRequest=${encodeURIComponent(text.trim())}`)
          return
        }
        const hex = await toRecipientPubkey(text)
        if (hex) navigate(`/send?to=${hex}`)
        else setError('That is not a payment request or an account we can find.')
      } finally {
        resolving.current = false
      }
    },
    [navigate],
  )

  useEffect(() => {
    let scanner: { start(): Promise<void>; destroy(): void } | undefined
    let cancelled = false

    void (async () => {
      const { default: QrScanner } = await import('qr-scanner')
      if (cancelled || !videoRef.current) return

      scanner = new QrScanner(videoRef.current, (result) => void accept(result.data), {
        highlightScanRegion: true,
        highlightCodeOutline: true,
      })
      try {
        await scanner.start()
      } catch (e) {
        setError(
          e instanceof Error
            ? `Camera unavailable: ${e.message}. Paste the code instead.`
            : 'Camera unavailable. Paste the code instead.',
        )
      }
    })()

    return () => {
      cancelled = true
      scanner?.destroy()
    }
  }, [accept])

  return (
    <Screen>
      <BackLink to="/" label="Back" />
      <PageHeader title="Scan" subtitle="A payment request, or someone's code" />

      <div className="overflow-hidden rounded-2xl bg-mono-900">
        <video ref={videoRef} className="aspect-square w-full object-cover" />
      </div>

      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      <Button
        variant="outline"
        className="mt-4 w-full"
        onClick={async () => {
          // `navigator.clipboard.readText()` is not implemented in the Android
          // WebView, so this button threw on every device it mattered on — and a
          // camera that will not open is exactly when it matters. See readClipboard.
          const text = await readClipboard()
          if (text === null) {
            setError('Could not read the clipboard. Paste the code below instead.')
            setTyped('')
          } else await accept(text)
        }}
      >
        <ClipboardPaste className="mr-2 h-4 w-4" /> Paste code
      </Button>

      {typed !== null && (
        <div className="mt-4">
          <Input
            label="Code"
            placeholder="vreqA… or an account"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <Button
            className="mt-3 w-full"
            disabled={typed.trim() === ''}
            onClick={() => void accept(typed.trim())}
          >
            Continue
          </Button>
        </div>
      )}
    </Screen>
  )
}
