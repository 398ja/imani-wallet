import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Cloud, CloudDownload, Download } from 'lucide-react'

import { Screen, BackLink, PageHeader, Panel, Button, Input, Alert } from '../components/ui'
import { applyBackup, backupFilename, createBackup, parseBackup, type ParsedBackup } from '../lib/backup'
import { downloadText } from '../lib/download'
import { driveConfigured, getBackup, putBackup } from '../lib/drive'
import { handleLabel } from '../lib/format'
import { keyStore } from '../lib/nap'
import { profileName, refreshProfile, type Profile } from '../lib/profile'

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

        {/* Same file, sent somewhere else. Inside the same panel rather than
            below it, because "download or Drive" is one decision about one
            thing, not two features that happen to share a screen. */}
        <div className="mt-3">
          <DriveBackupPanel pubkey={profile.pubkey} />
        </div>
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
 * The same account file, sent to the customer's own Google Drive.
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
 */
export function DriveBackupPanel({ pubkey }: { pubkey: string }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!driveConfigured()) return null

  const save = async () => {
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
  }

  return (
    <>
      <Button
        variant="secondary"
        className="w-full"
        disabled={busy}
        onClick={() => void save()}
      >
        <Cloud className="h-4 w-4" />
        <span className="ml-2">{busy ? 'Backing up…' : 'Back up to Google Drive'}</span>
      </Button>

      {done && (
        <p className="mt-2 text-sm text-green-700 dark:text-green-500">Saved to your Google Drive.</p>
      )}
      {error && <Alert>{error}</Alert>}
    </>
  )
}

/**
 * Restore from the customer's own Google Drive.
 *
 * The order of the screen is the order the customer needs: sign in, then be
 * TOLD whose account this is before being asked for anything. The npub rides in
 * the clear precisely so this step can happen — someone who has lost a phone
 * should not have to recognise an account by whether a passphrase prompt
 * accepts their typing.
 *
 * The passphrase is then required, exactly as it is for a file off disk. Drive
 * is where the file lives, never what protects it: an attacker with the
 * customer's Google account gets an encrypted envelope and nothing else.
 */
function DriveRestorePanel({ onUnlock }: { onUnlock: (privkeyHex: string) => Promise<void> }) {
  const [parsed, setParsed] = useState<ParsedBackup | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  // The stored profile is a snapshot from whenever the backup was written, so
  // the relay is asked for a fresher one. Best-effort: a customer standing in a
  // shop with no signal must still be able to restore, and the npub below
  // identifies the account on its own.
  useEffect(() => {
    const pubkey = parsed?.profile?.pubkey
    if (!pubkey) return
    let live = true
    void refreshProfile(pubkey)
      .then((p) => live && setName(profileName(p)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [parsed])

  if (!driveConfigured()) return null

  const fetchBackup = async () => {
    setBusy(true)
    setError(null)
    try {
      const text = await getBackup()
      if (text === null) {
        setError('That Google account has no wallet backup in it.')
        return
      }
      const backup = parseBackup(text)
      setParsed(backup)
      setName(backup.profile ? profileName(backup.profile) : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!parsed) return
    setBusy(true)
    setError(null)
    try {
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
    <>
      {!parsed && (
        <Button size="lg" className="w-full" disabled={busy} onClick={() => void fetchBackup()}>
          <CloudDownload className="h-4 w-4" />
          <span className="ml-2">{busy ? 'Checking Google Drive…' : 'Restore from Google Drive'}</span>
        </Button>
      )}

      {parsed && (
        <Panel className="p-4">
          <p className="text-sm text-mono-500">This backup holds the account</p>
          <p className="mt-1 font-medium text-mono-900 dark:text-mono-50">
            {name ?? 'Unnamed account'}
          </p>
          {/* Shown in full, not truncated. It is what a customer with two
              accounts checks before overwriting one. */}
          {parsed.npub && (
            <p className="mt-1 break-all font-mono text-xs text-mono-500">{parsed.npub}</p>
          )}

          <p className="mt-3 text-sm text-mono-600 dark:text-mono-300">
            Enter the passphrase for this account.
          </p>

          <Input
            className="mt-2"
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoComplete="current-password"
            autoFocus
          />

          <Button
            size="lg"
            className="mt-3 w-full"
            disabled={busy || !passphrase}
            onClick={() => void restore()}
          >
            {busy ? 'Restoring…' : 'Restore this account'}
          </Button>

          {error && <Alert>{error}</Alert>}
        </Panel>
      )}

      {!parsed && error && <Alert>{error}</Alert>}
    </>
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
      const nip05 = backup.profile?.nip05
      setLoaded((nip05 && handleLabel(nip05)) ?? backup.profile?.displayName ?? file.name)
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
      <PageHeader title="Restore" subtitle="Get your account back on this device." />

      <DriveRestorePanel onUnlock={onUnlock} />

      <p className="text-sm text-mono-500">Or open a backup file from another browser or device.</p>

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
