import { useState } from 'react'

import { createBackup } from './backup'
import { driveConfigured, putBackup } from './drive'

/**
 * Sending the account file to the customer's own Google Drive.
 *
 * The remote half of the choice offered after onboarding: local is a download,
 * remote is this. Identical bytes either way — `createBackup` is the one
 * format, so a file written here restores from disk and vice versa.
 *
 * It costs no self-custody. The file goes to a hidden folder in storage the
 * customer owns, browser-to-Google, and no Imani server sees a key. "There is
 * no honeypot" stays literally true.
 *
 * No passphrase is asked for and none is optional: the file carries nap's
 * envelope verbatim, already encrypted by the passphrase this account was
 * created with, and restoring it demands that passphrase. Uploading is
 * therefore a copy, not a decryption — there is nothing here to unlock.
 *
 * A hook rather than a component, because the two screens that offer this put
 * the button in different places — full width under Settings, one cell of a
 * three-button row after onboarding. Owning its own layout meant the component
 * could only ever fit one of them.
 */
export function useDriveBackup(pubkey: string) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return {
    /**
     * Whether the deployment can actually complete a Drive backup.
     *
     * Callers show the button either way — a backup option that appears only on
     * some deployments teaches nobody it exists. This is for wording: it says
     * whether a click will reach Google or explain why it cannot.
     */
    configured: driveConfigured(),
    busy,
    done,
    error,
    save: async () => {
      setBusy(true)
      setError(null)
      setDone(false)
      try {
        await putBackup(createBackup(pubkey))
        setDone(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
  }
}
