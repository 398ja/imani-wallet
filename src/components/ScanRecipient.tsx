import { useEffect, useRef, useState } from 'react'
import { ClipboardPaste } from 'lucide-react'

import { Button, Alert, Input } from './ui'
import { toRecipientPubkey } from '../lib/issue'
import { readClipboard } from '../lib/native'

/**
 * Read someone's address off their screen: camera, typed handle, or paste.
 *
 * Lifted out of SellPage, where it was `ScanCustomer`, because the customer's
 * own send flow needs exactly the same three ways in. One copy, so a fix to the
 * scanner's debounce or the paste fallback lands on both.
 *
 * What comes back is a NIP-05 handle, which `toRecipientPubkey` resolves; npub
 * and hex still work — vouchers are addressed to a pubkey either way, and on a
 * dev machine, where no handle resolves, they are the only forms that do.
 */
export function ScanRecipient({
  onFound,
  /** This wallet's own pubkey. Given, sending to yourself is refused. */
  selfPubkey,
  manualLabel = 'Or enter their handle',
}: {
  onFound: (pubkey: string) => void
  selfPubkey?: string
  manualLabel?: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState('')
  const [looking, setLooking] = useState(false)

  /**
   * Shared by all three ways in, so the self-send refusal cannot be reachable
   * through one of them. A send to yourself is not a no-op — it burns the
   * source voucher through the saga and hands back an equal one, costing a
   * round trip and a mint fee to end up where you started.
   */
  const isSelf = (hex: string) =>
    selfPubkey !== undefined && hex.toLowerCase() === selfPubkey.toLowerCase()

  useEffect(() => {
    let scanner: { start(): Promise<void>; destroy(): void } | undefined
    let cancelled = false

    // A handle costs a round trip to resolve, and the scanner fires several
    // times a second on the same code — without this the phone opens a dozen
    // identical lookups while the first is still in flight.
    let resolving = false

    const accept = async (text: string) => {
      if (resolving) return
      resolving = true
      try {
        const hex = await toRecipientPubkey(text)
        if (cancelled) return
        if (!hex) {
          setError('That code is not an account we can find.')
          return
        }
        if (isSelf(hex)) {
          setError('That is your own address.')
          return
        }
        onFound(hex)
      } finally {
        resolving = false
      }
    }

    ;(async () => {
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
            ? `Camera unavailable: ${e.message}. Paste their code instead.`
            : 'Camera unavailable. Paste their code instead.',
        )
      }
    })()

    return () => {
      cancelled = true
      scanner?.destroy()
    }
    // onFound is a setState updater and selfPubkey is fixed for the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submitManual = async () => {
    setError(null)
    setLooking(true)
    const hex = await toRecipientPubkey(manual)
    setLooking(false)
    if (!hex) {
      setError('That is not an account we can find.')
      return
    }
    if (isSelf(hex)) {
      setError('That is your own address.')
      return
    }
    onFound(hex)
  }

  return (
    <>
      <div className="overflow-hidden rounded-2xl bg-mono-900">
        <video ref={videoRef} className="aspect-square w-full object-cover" />
      </div>

      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <Input
          label={manualLabel}
          placeholder="name"
          value={manual}
          onChange={(e) => {
            setManual(e.target.value)
            // Clears a stale refusal as soon as they start fixing it, rather
            // than leaving "that is your own address" under a new handle.
            if (error) setError(null)
          }}
        />
        <Button
          variant="outline"
          className="w-full"
          disabled={looking || manual.trim() === ''}
          onClick={() => void submitManual()}
        >
          {looking ? 'Looking them up…' : 'Continue'}
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          onClick={async () => {
            const text = await readClipboard()
            if (text === null) setError('Could not read the clipboard.')
            else setManual(text.trim())
          }}
        >
          <ClipboardPaste className="mr-2 h-4 w-4" /> Paste
        </Button>
      </div>
    </>
  )
}
