import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Download } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Input, Alert } from '../components/ui'
import { applyBackup, backupFilename, createBackup, parseBackup, type ParsedBackup } from '../lib/backup'
import { downloadText } from '../lib/download'
import { keyStore } from '../lib/nap'
import type { Profile } from '../lib/profile'

/**
 * Save a copy of the account.
 *
 * The file holds the same passphrase-encrypted key the browser holds, so it is
 * useless to anyone without the passphrase — which is what makes it a backup
 * rather than a second thing to keep secret.
 */
export function BackupPage({ profile }: { profile: Profile }) {
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const save = () => {
    setError(null)
    try {
      downloadText(backupFilename(profile), createBackup(profile.pubkey))
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Screen>
      <BackLink to="/settings" label="Settings" />
      <PageHeader title="Backup" subtitle="Keep a copy of your account somewhere safe." />

      <Panel className="mb-4 p-4">
        <p className="text-sm text-mono-600 dark:text-mono-300">
          This file contains your key, encrypted with your passphrase, and your profile. You will
          need both the file and your passphrase to restore.
        </p>
        <Button className="mt-4 w-full" onClick={save}>
          <Download className="h-4 w-4" />
          <span className="ml-2">Download backup file</span>
        </Button>
        {done && <p className="mt-2 text-sm text-green-700 dark:text-green-500">Backup downloaded.</p>}
        {error && <Alert>{error}</Alert>}
      </Panel>

      <p className="text-sm text-mono-500">
        A backup file will not help if you forget your passphrase. For that you need your backup key,
        under{' '}
        <Link to="/settings/security" className="pressable underline hover:text-mono-900 dark:hover:text-mono-50">
          Security
        </Link>
        .
      </p>
    </Screen>
  )
}

/**
 * Restore from a backup file.
 *
 * Public: reached from the login screen by someone who has no key in this
 * browser yet. Restoring writes the encrypted key back and then still asks for
 * the passphrase — the file on its own must not be enough to get in.
 */
export function RestorePage({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedBackup | null>(null)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  // Parsing only. Choosing a file must not touch the key this browser already
  // holds — /restore is linked from the login screen, so there usually is one,
  // and picking the wrong file would otherwise destroy it before anyone had
  // typed a passphrase.
  const pick = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const backup = parseBackup(await file.text())
      setParsed(backup)
      setLoaded(backup.profile?.nip05 ?? backup.profile?.displayName ?? file.name)
    } catch (e) {
      setParsed(null)
      setLoaded(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const unlock = async () => {
    if (!parsed) return
    setBusy(true)
    setError(null)
    try {
      // applyBackup installs the key, verifies it with this passphrase, and
      // rolls back to the previous record if the passphrase does not open it.
      const { privkeyHex } = await applyBackup(parsed, () => keyStore.loadKey(passphrase))
      await onUnlock(privkeyHex)
      navigate('/', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 p-6">
      <PageHeader title="Restore" subtitle="Open a backup file from another browser or device." />

      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        onChange={(e) => void pick(e.target.files?.[0])}
        className="block w-full text-sm text-mono-500 file:mr-3 file:rounded-xl file:border-0 file:bg-mono-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-mono-900 dark:file:bg-mono-800 dark:file:text-mono-50"
      />

      {loaded && (
        <>
          <p className="text-sm text-mono-500">
            Loaded <span className="font-medium text-mono-900 dark:text-mono-50">{loaded}</span>.
            Enter the passphrase for this backup.
          </p>
          <Input
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          <Button
            size="lg"
            className="w-full"
            disabled={busy || !passphrase}
            onClick={() => void unlock()}
          >
            {busy ? 'Restoring…' : 'Restore and unlock'}
          </Button>
        </>
      )}

      {error && <Alert>{error}</Alert>}

      <p className="text-center text-sm text-mono-500">
        <Link to="/onboarding" className="pressable underline hover:text-mono-900 dark:hover:text-mono-50">
          Back
        </Link>
      </p>
    </div>
  )
}
