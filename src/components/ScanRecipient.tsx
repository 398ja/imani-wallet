import { useEffect, useRef, useState } from 'react'
import { ClipboardPaste } from 'lucide-react'

import { Button, Alert, Input } from './ui'
import { resolveRecipient } from '../lib/issue'
import { readClipboard } from '../lib/native'
import { scannerBlocked } from '../lib/scannerSupport'

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
  onText,
  placeholder = 'name',
  pasteSubmits = false,
}: {
  /**
   * The second argument is the NIP-05 the person was reached THROUGH, when they
   * were reached through one. Optional on purpose: three of the four callers
   * only need a key, and a handle is the difference between "Send to @cocoa"
   * and "Send to a1b2c3d4…ef56" on the screens that name them before their
   * kind-0 arrives.
   */
  onFound: (pubkey: string, handle?: string) => void
  selfPubkey?: string
  manualLabel?: string
  /**
   * Sees the raw scanned or typed text first. Return true to consume it, so it is not
   * resolved as an account (the terminal setup code, #160). Its own error copy is the
   * caller's to show. Return false to let it through to the account lookup (Sell, which
   * consumes a receipt and sells to anyone else, spec 049). `source` says whether it was
   * scanned or pasted/typed, for a caller that words the two differently (a receipt sent as text).
   */
  onText?: (text: string, source: 'camera' | 'typed') => boolean
  /** The paste field's placeholder. */
  placeholder?: string
  /**
   * Paste goes straight to `onText` instead of into the field. For a code nobody reads or edits
   * (a receipt), so a pasted message does not sit in a one-line box waiting for Continue.
   */
  pasteSubmits?: boolean
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
      if (onText?.(text, 'camera')) return
      resolving = true
      try {
        const found = await resolveRecipient(text)
        if (cancelled) return
        if (!found) {
          setError('That code is not an account we can find.')
          return
        }
        if (isSelf(found.pubkey)) {
          setError('That is your own address.')
          return
        }
        onFound(found.pubkey, found.handle)
      } finally {
        resolving = false
      }
    }

    ;(async () => {
      // Before the camera, for the reason in lib/scannerSupport: a refused
      // decoder worker leaves a live preview that never reads anything, which
      // is indistinguishable from nobody holding up a code. This screen always
      // carries its handle field, so saying so costs nothing but the words.
      const blocked = await scannerBlocked()
      if (cancelled) return
      if (blocked) {
        setError(blocked)
        return
      }

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
    if (onText?.(manual.trim(), 'typed')) return
    setLooking(true)
    const found = await resolveRecipient(manual)
    setLooking(false)
    if (!found) {
      setError('That is not an account we can find.')
      return
    }
    if (isSelf(found.pubkey)) {
      setError('That is your own address.')
      return
    }
    onFound(found.pubkey, found.handle)
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
          placeholder={placeholder}
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
            else if (pasteSubmits && onText?.(text.trim(), 'typed')) setManual('')
            else setManual(text.trim())
          }}
        >
          <ClipboardPaste className="mr-2 h-4 w-4" /> Paste
        </Button>
      </div>
    </>
  )
}
