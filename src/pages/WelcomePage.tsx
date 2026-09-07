import { useState } from 'react'
import { Copy, Check, Download, Eye, EyeOff } from 'lucide-react'

import { Button, Panel, Alert } from '../components/ui'
import type { Profile } from '../lib/profile'
import { backupFilename, createBackup } from '../lib/backup'
import { downloadText } from '../lib/download'
import { driveConfigured } from '../lib/drive'
import { handleLabel } from '../lib/format'
import { DriveBackupPanel } from './BackupPages'

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
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

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
        <h2 className="text-sm font-medium text-mono-900 dark:text-mono-50">Your backup key</h2>
        <p className="mt-1 text-xs text-mono-500">
          This is the only way back into your account if you forget your passphrase or use another
          device. Save it somewhere safe. It will not be shown again.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <input
            readOnly
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
            aria-label={revealed ? 'Hide key' : 'Show key'}
            className="pressable shrink-0 rounded-xl border border-mono-200 p-2 text-mono-500 hover:bg-mono-100 dark:border-mono-700 dark:hover:bg-mono-800"
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="ml-2">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
          <Button
            variant="secondary"
            onClick={() => downloadText('imani-wallet-backup-key.txt', nsec)}
          >
            <Download className="h-4 w-4" />
            <span className="ml-2">Download</span>
          </Button>
        </div>
      </Panel>

      <BackUpAccount profile={profile} />

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

/**
 * Where the account file goes: this device, or the customer's own Drive.
 *
 * Offered here rather than only under Settings because this is the one moment
 * every customer passes through, and the moment the file is worth least to lose
 * — nothing has been earned yet. A stall owner who taps past it now is the one
 * who cannot be helped later.
 *
 * The same bytes either way. `createBackup` is the one format, so a file
 * downloaded here restores from Drive and vice versa, and the passphrase this
 * account was just created with is what opens it in both places. Neither button
 * asks for that passphrase: the file carries nap's envelope already encrypted,
 * so writing it is a copy and not a decryption.
 *
 * Deliberately NOT a replacement for the backup key above it. That is the raw
 * nsec, which opens the account with nothing else; this is a file that is
 * useless without the passphrase. They fail differently, which is the reason to
 * have both.
 */
function BackUpAccount({ profile }: { profile: Profile }) {
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = () => {
    setError(null)
    try {
      downloadText(backupFilename(profile), createBackup(profile.pubkey))
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Panel className="p-4">
      <h2 className="text-sm font-medium text-mono-900 dark:text-mono-50">Back up your account</h2>
      <p className="mt-1 text-xs text-mono-500">
        {driveConfigured()
          ? 'A file holding your key, encrypted with your passphrase, and your profile. Keep it on this device, or put it in your own Google Drive — either one gets you back in on a new phone.'
          : 'A file holding your key, encrypted with your passphrase, and your profile. It gets you back in on a new phone.'}
      </p>

      <Button variant="secondary" className="mt-3 w-full" onClick={download}>
        <Download className="h-4 w-4" />
        <span className="ml-2">Save backup file</span>
      </Button>
      {done && <p className="mt-2 text-xs text-green-700 dark:text-green-500">Backup saved.</p>}
      {error && <Alert>{error}</Alert>}

      <div className="mt-2">
        <DriveBackupPanel pubkey={profile.pubkey} />
      </div>
    </Panel>
  )
}
