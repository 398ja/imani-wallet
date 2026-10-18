import { useEffect, useState } from 'react'

import { Alert, Button, Input } from './ui'
import { gatewayConfig } from '../lib/config'
import { HandleTakenError } from '../lib/registration'
import { validateHandle } from '../lib/validate'
import { userMessage } from '../lib/userMessage'

/**
 * The step a key with no profile meets before it is let in (#325).
 *
 * The service does not accept accounts without a profile, so a key brought to
 * this device whose account has no directory record is not logged in as an
 * anonymous account. It picks a handle here, the same way registration does,
 * and only once that handle is claimed does the wallet open.
 *
 * Nothing has been written to the device when this shows: the caller checked
 * the directory before installing the key.
 */
export function FinishProfileStep({
  onClaim,
  onCancel,
}: {
  /** Claim this handle for the key, then log in. Throws HandleTakenError on a taken handle. */
  onClaim: (handle: string) => Promise<void>
  onCancel: () => void
}) {
  const [handle, setHandle] = useState('')
  const [domain, setDomain] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    gatewayConfig().then(
      (c) => setDomain(c.nip05Domain),
      () => setDomain(null),
    )
  }, [])

  const handleError = handle === '' ? undefined : validateHandle(handle)

  const submit = async () => {
    if (busy || handle === '' || handleError) return
    setBusy(true)
    setError(null)
    try {
      await onClaim(handle)
    } catch (e) {
      setError(
        e instanceof HandleTakenError
          ? `@${handle} is taken. Try another.`
          : userMessage(e),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-mono-900 dark:text-mono-50">Finish your profile</h2>
        <p className="mt-0.5 text-sm text-mono-500">
          This account has no profile yet, and every account needs one. Pick a handle to finish
          setting it up.
        </p>
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="text-mono-400" aria-hidden>
              @
            </span>
            <Input
              placeholder="your-handle"
              aria-label="Handle"
              value={handle}
              onChange={(e) => {
                setHandle(e.target.value.toLowerCase())
                if (error) setError(null)
              }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
              autoFocus
              disabled={busy}
            />
          </div>
          <p className="mt-1 text-xs text-mono-500">
            {handleError ? (
              <span className="text-red-600 dark:text-red-400">{handleError}</span>
            ) : domain ? (
              `You will be @${handle || 'your-handle'}`
            ) : (
              ' '
            )}
          </p>
        </div>

        {error && <Alert>{error}</Alert>}

        <Button type="submit" size="lg" className="w-full" disabled={busy || handle === '' || !!handleError}>
          {busy ? 'Finishing…' : 'Finish and log in'}
        </Button>
      </form>

      <Button variant="ghost" className="w-full" disabled={busy} onClick={onCancel}>
        Back
      </Button>
    </div>
  )
}
