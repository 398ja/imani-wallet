import { useState } from 'react'
import { nip19 } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import { Check, Cloud, Copy, Download } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Input, Alert } from '../components/ui'
import { backupFilename, createBackup } from '../lib/backup'
import { downloadText } from '../lib/download'
import { useDriveBackup } from '../lib/useDriveBackup'
import { keyStore } from '../lib/nap'
import { type Profile } from '../lib/profile'
import { userMessage } from '../lib/userMessage'

/**
 * Save a copy of the account.
 *
 * The file holds the same passphrase-encrypted key the browser holds, so it is
 * useless to anyone without the passphrase — which is what makes it a backup
 * rather than a second thing to keep secret.
 */
export function BackupPage({ profile, terminal }: { profile: Profile; terminal?: boolean }) {
  const drive = useDriveBackup(profile.pubkey)
  const [passphrase, setPassphrase] = useState('')
  const [nsec, setNsec] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const download = async () => {
    setError(null)
    try {
      await downloadText(backupFilename(profile), createBackup(profile.pubkey))
      setDownloaded(true)
    } catch (e) {
      setError(userMessage(e))
    }
  }

  const reveal = async () => {
    setBusy(true)
    setError(null)
    try {
      const hex = await keyStore.loadKey(passphrase)
      setNsec(nip19.nsecEncode(hexToBytes(hex)))
      setPassphrase('')
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!nsec) return
    try {
      await navigator.clipboard.writeText(nsec)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused — insecure context, denied permission.
      // Silently doing nothing would leave the user believing their only backup
      // key is on the clipboard when it is not. The key is already on screen
      // here, so say so and let them select it.
      setError('Could not copy. Select the key above and copy it manually.')
    }
  }

  // A terminal holds a disposable credential the stall owner issued authority
  // against, not an account key its holder should ever write down. Offering one
  // the reveal would send them hunting for a backup key that was never theirs —
  // the rule Security has always applied, carried over with the panel rather
  // than left behind on the screen it came from.
  const canReveal = !terminal

  const buttons = (canReveal && nsec ? 1 : 0) + 2

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Backup" subtitle="Keep a copy of your account somewhere safe." />

      <Panel className="mb-4 p-4">
        <p className="text-sm text-mono-600 dark:text-mono-300">
          The file holds your key, encrypted with your passphrase, and your profile — you need both
          it and the passphrase to restore.
          {canReveal && ' Your backup key is the key itself, and needs nothing else.'}
        </p>

        {canReveal && nsec && (
          <Panel className="mt-3 break-all bg-mono-100 p-3 font-mono text-xs text-mono-900 dark:bg-mono-800 dark:text-mono-50">
            {nsec}
          </Panel>
        )}

        {/* Same shape as the screen after onboarding: one row, one decision.
            Copy is the only one that needs the passphrase, so it joins the row
            once the key is out rather than sitting there disabled. */}
        <div className={`mt-3 grid gap-2 ${buttons === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {canReveal && nsec && (
            <Button variant="secondary" className="flex-col px-2 py-2 text-xs" onClick={() => void copy()}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span className="mt-1">{copied ? 'Copied' : 'Copy backup key'}</span>
            </Button>
          )}

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

        {drive.done && (
          <p className="mt-2 text-sm text-green-700 dark:text-green-500">Saved to your Google Drive.</p>
        )}

        {canReveal && nsec && (
          <Button variant="ghost" className="mt-2 w-full" onClick={() => setNsec(null)}>
            Hide backup key
          </Button>
        )}

        {/* Re-asking for the passphrase is not ceremony: an unlocked wallet left
            open on a market stall would otherwise hand its key to anyone who
            opens this screen. The file and the Drive copy need no such gate —
            both are encrypted before they go anywhere. */}
        {canReveal && !nsec && (
          <div className="mt-4 border-t border-mono-200 pt-4 dark:border-mono-800">
            <p className="text-sm text-mono-500">
              Anyone with your backup key controls your account and your vouchers. Only show it
              somewhere private.
            </p>
            <Input
              className="mt-2"
              type="password"
              placeholder="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="current-password"
            />
            <Button
              variant="secondary"
              className="mt-2 w-full"
              disabled={busy || !passphrase}
              onClick={() => void reveal()}
            >
              {busy ? 'Checking…' : 'Show my backup key'}
            </Button>
          </div>
        )}

        {/* Both, because they fail independently: a Drive refusal must not be
            swallowed just because the local download went fine. `drive.save`
            reports through its own state rather than throwing, so this is the
            only place its message can surface. */}
        {(error ?? drive.error) && <Alert>{error ?? drive.error}</Alert>}
      </Panel>
    </Screen>
  )
}
