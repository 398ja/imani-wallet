import { useState } from 'react'
import { Copy, Check, Cloud, Download, Eye, EyeOff } from 'lucide-react'

import { Button, Panel, Alert } from '../components/ui'
import type { Profile } from '../lib/profile'
import { backupFilename, createBackup } from '../lib/backup'
import { downloadText } from '../lib/download'
import { handleLabel, handleOf } from '../lib/format'
import { useDriveBackup } from '../lib/useDriveBackup'
import { DriveOverwriteWarning } from '../components/DriveOverwriteWarning'
import { userMessage } from '../lib/userMessage'

/**
 * Save your key. The only screen in the app that cannot be undone by trying
 * again.
 *
 * There is no password reset and no account recovery: nothing on any server can
 * reproduce this key. If the user closes the tab without copying it and later
 * forgets the passphrase, the account and its coupons are gone. So the screen is
 * modal by construction (App renders it INSTEAD of the router, not as a route)
 * and Continue stays disabled until the checkbox is ticked.
 *
 * Hidden behind a reveal by default because "shown on screen" and "written down"
 * are different things, and the first invites a shoulder-surfer for no benefit.
 */
export function WelcomePage({
  nsec,
  profile,
  onDone,
}: {
  nsec: string
  profile: Profile
  onDone: () => void
}) {
  const drive = useDriveBackup(profile.pubkey)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const download = async () => {
    setError(null)
    try {
      await downloadText(backupFilename(profile), createBackup(profile.pubkey))
      setDownloaded(true)
    } catch (e) {
      setError(userMessage(e))
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(nsec)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused (permissions, insecure context). The
      // reveal-and-retype path still works, so this is not worth an error state.
      setRevealed(true)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-mono-900 dark:text-mono-50">You are all set</h1>
        {profile.nip05 && (
          <p className="mt-1 text-sm text-mono-900 dark:text-mono-50">
            {handleLabel(profile.nip05)}
          </p>
        )}
      </div>

      <Panel className="p-4">
        <h2 className="text-sm font-medium text-mono-900 dark:text-mono-50">Back up your account</h2>
        <p className="mt-1 text-xs text-mono-500">
          This is the only way back in if you forget your passphrase or use another device. The key
          below is not shown again — copy it, or keep the backup file, which holds the same key
          encrypted with your passphrase.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <input
            readOnly
            aria-label="Your backup key"
            type={revealed ? 'text' : 'password'}
            value={nsec}
            // Selecting on focus makes a manual copy one gesture rather than a
            // drag across a 63-character string.
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 flex-1 rounded-xl border border-mono-200 bg-white px-3 py-2 font-mono text-xs text-mono-900 dark:border-mono-700 dark:bg-mono-800 dark:text-mono-50"
          />
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? 'Hide backup key' : 'Show backup key'}
            className="pressable shrink-0 rounded-xl border border-mono-200 p-2 text-mono-500 hover:bg-mono-100 dark:border-mono-700 dark:hover:bg-mono-800"
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        {/* Icon over label, not beside it. Three of these across a phone leaves
            about 100px each, which "Google Drive" does not fit on one line
            next to an icon. */}
        <div className="mt-2 grid grid-cols-3 gap-2">
          <Button variant="secondary" className="flex-col px-2 py-2 text-xs" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="mt-1">{copied ? 'Copied' : 'Copy backup key'}</span>
          </Button>

          {/* The account FILE, not the nsec as text. One artifact for both
              backup buttons — the two of them are the same thing going to two
              places, and only the clipboard button deals in the raw key. */}
          <Button variant="secondary" className="flex-col px-2 py-2 text-xs" onClick={download}>
            <Download className="h-4 w-4" />
            <span className="mt-1">{downloaded ? 'Saved' : 'Download file'}</span>
          </Button>

          <Button
            variant="secondary"
            className="flex-col px-2 py-2 text-xs"
            disabled={drive.busy}
            onClick={() => void drive.save()}
          >
            <Cloud className="h-4 w-4" />
            <span className="mt-1">{drive.busy ? 'Saving…' : 'Google Drive'}</span>
          </Button>
        </div>

        <div className="mt-3">
          <DriveOverwriteWarning who={handleOf(profile.nip05)} />
        </div>

        {drive.done && (
          <p className="mt-2 text-xs text-green-700 dark:text-green-500">
            Saved to your Google Drive.
          </p>
        )}
        {(error ?? drive.error) && <Alert>{error ?? drive.error}</Alert>}
      </Panel>

      <label className="flex items-start gap-3 text-sm text-mono-600 dark:text-mono-300">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-mono-900 dark:accent-mono-50"
        />
        I have saved my backup key somewhere safe.
      </label>

      <Button size="lg" className="w-full" disabled={!saved} onClick={onDone}>
        Continue to my wallet
      </Button>
    </div>
  )
}
