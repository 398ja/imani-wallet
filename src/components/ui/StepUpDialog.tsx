import { useEffect, useRef, useState } from 'react'
import { Button, Input, Alert } from './index'
import { userMessage } from '../../lib/userMessage'

/**
 * Confirm-it's-you before a consequential action (imani-wallet#434: closing the stall).
 *
 * Says WHY the passphrase is needed before asking for it, and Cancel leaves everything as it was.
 * Same look as ReauthDialog, but not a session screen: there is no log-out exit here, because
 * nothing about the session is wrong.
 */
export function StepUpDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  /** Verify the passphrase and do the thing. Reject to show the error and keep the dialog open. */
  onConfirm: (passphrase: string) => Promise<void>
  onCancel: () => void
}) {
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async () => {
    if (!passphrase || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(passphrase)
      setPassphrase('')
    } catch (e) {
      setError(userMessage(e))
      inputRef.current?.select()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      aria-describedby="stepup-body"
      className="fixed inset-0 z-[100] flex items-center justify-center p-5"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div
        aria-hidden="true"
        className="modal-scrim absolute inset-0 bg-mono-950/40 backdrop-blur-md dark:bg-mono-950/60"
      />
      <div className="relative w-full max-w-sm rounded-3xl bg-white/90 p-6 shadow-xl ring-1 ring-mono-900/5 dark:bg-mono-900/90 dark:ring-white/10">
        <h2
          id="stepup-title"
          className="text-[17px] font-semibold leading-snug tracking-[-0.01em] text-mono-900 dark:text-mono-50"
        >
          {title}
        </h2>
        <p id="stepup-body" className="mt-1 text-[13px] leading-snug text-mono-600 dark:text-mono-300">
          {body}
        </p>

        <div className="mt-5 space-y-3">
          <Input
            ref={inputRef}
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            disabled={busy}
            autoComplete="current-password"
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
          <Button size="lg" className="w-full" disabled={busy || !passphrase} onClick={() => void submit()}>
            {busy ? 'Checking…' : confirmLabel}
          </Button>
          <Button variant="ghost" className="w-full" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>

        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}
      </div>
    </div>
  )
}
