import { useEffect, useState } from 'react'

import { Alert, Button, Input } from './ui'
import { gatewayConfig } from '../lib/config'
import { HandleTakenError } from '../lib/registration'
import { acceptTerms, termsUrl, type TermsAcceptance } from '../lib/terms'
import { normaliseHandle, validateHandle } from '../lib/validate'
import { userMessage } from '../lib/userMessage'
import { TermsCheckbox } from './TermsCheckbox'

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
 *
 * Claiming a key's FIRST handle is what creates its account on the service, so
 * this asks for the Terms and Conditions exactly as registration does (review
 * of #358): an unticked box, and the button stays disabled until it is ticked.
 */
export function FinishProfileStep({
  onClaim,
  onCancel,
  intro = 'This account has no profile yet, and every account needs one. Pick a handle to finish setting it up.',
  submitLabel = 'Finish and log in',
  cancelLabel = 'Back',
}: {
  /**
   * Claim this handle for the key, then log in. Throws HandleTakenError on a taken handle. `terms`
   * is the acceptance, stamped at submit; `claimProfile` refuses without it.
   */
  onClaim: (handle: string, terms: TermsAcceptance) => Promise<void>
  onCancel: () => void
  /**
   * The words around the form. Login uses the defaults; the logged-in profile
   * card (#332) is already inside the wallet, so it says "Finish" and "Not now".
   */
  intro?: string
  submitLabel?: string
  cancelLabel?: string
}) {
  const [handle, setHandle] = useState('')
  const [domain, setDomain] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Review of #358: unticked to start; null on a build that names no website.
  const terms = termsUrl()
  const [termsTicked, setTermsTicked] = useState(false)
  const termsOk = terms !== null && termsTicked

  useEffect(() => {
    gatewayConfig().then(
      (c) => setDomain(c.nip05Domain),
      () => setDomain(null),
    )
  }, [])

  const handleError = handle === '' ? undefined : validateHandle(handle)

  const submit = async () => {
    if (busy || handle === '' || handleError || !termsOk) return
    setBusy(true)
    setError(null)
    try {
      await onClaim(handle, acceptTerms())
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
        <p className="mt-0.5 text-sm text-mono-500">{intro}</p>
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
              placeholder="your_handle"
              aria-label="Handle"
              value={handle}
              onChange={(e) => {
                setHandle(normaliseHandle(e.target.value))
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
              `You will be @${handle || 'your_handle'}`
            ) : (
              ' '
            )}
          </p>
        </div>

        {error && <Alert>{error}</Alert>}

        <TermsCheckbox url={terms} checked={termsTicked} disabled={busy} onChange={setTermsTicked} />

        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={busy || handle === '' || !!handleError || !termsOk}
        >
          {busy ? 'Finishing…' : submitLabel}
        </Button>
      </form>

      <Button variant="ghost" className="w-full" disabled={busy} onClick={onCancel}>
        {cancelLabel}
      </Button>
    </div>
  )
}
